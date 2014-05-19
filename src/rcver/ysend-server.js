/**************************************************************************
 * <p>Title: YRcvServer</p>
 * <p>Description: gpns-rcver发送服务,基于tcp，用于发送msg及pushAdds</p>
 * @author   shifengxuan
 * @version  1.00
 * @date     2013-12-18
 ***************************************************************************/

var net = require('net'), util = require('util');
var UData = require('../common/ydata-parser').UData, cNodeNode = require('../common/cnode-base.js'),
    YSendSocket = require('./ysend-socket').YSendSocket, redisClient = require('../common/credis-client').redisClient,
    YCmdMsg = require('../common/ycmd-msg').YCmdMsg, ECmdType = require('../common/ycmd-msg').ECmdType;

/**
 * gpns-rcver 接收来自gpns-sender的连接，发送msgPushAddsQueue中的msgPushAdds给gpns-sender的服务(基于tcp)
 * @param msgPushAddsQueue 发送msgPushAddsQueue中的msgPushAdds给gpns-sender的服务
 * @param param
 *   <li>param.port: tcp服务的端口
 *   <li>param.sendMsgToPushAddsPer: 每次发送给连接来的socket的pushAdds的个数
 *   <li>param.sendMsgStartLate: 服务启动后多少ms，开始检测是否有msgPushs要发送，等待的时间供gpns-sender连接
 * @constructor
 */
function YSendServer(msgPushAddsQueue, param) {
    this.server = null;
    this._childSocketMap = new Array();				//存储子进程连接过来的socket，value=YSendSocket,key=YSendSocket.remoteId
    this._msgPushAddsQueue = msgPushAddsQueue;
    this._param = param;
    this._onClose = null;
}

util.inherits(YSendServer, cNodeNode.CNodeBase);

/**
 * 设置关闭事件
 * @param onClose
 */
YSendServer.prototype.setOnClose = function (onClose) {
    this._onClose = onClose;
};

/**
 * 启动服务
 */
YSendServer.prototype.start = function () {
    this._startRcvSocket();
};

/**
 * 关闭服务
 */
YSendServer.prototype.close = function () {
    if (this.server) this.server.close();
};

/**
 * 服务关闭时，调用此函数
 */
YSendServer.prototype._emitClose = function () {
    if (this.server) {
        this._errorSendServer('close');
        this.server = null;
        if (this._onClose) this._onClose();
    }
};

/**
 * 启动接收socket，为sender提供建立sender和rcver之间socket通道的监听服务器，其中sender每启动一个child进程之前，
 * 都会连接该监听服务器，以建立与rcver的socket通道，该通道有2个作用：1、为rcver提供推送消息至sender的通道；
 * 2、为
 */
YSendServer.prototype._startRcvSocket = function () {
    var thisObj = this;
    this.server = net.createServer();
    this.server.on('connection', function (socket) {
        var sendSo = new YSendSocket(socket, function (thisSendSocket) {
            delete thisObj._childSocketMap[thisSendSocket.remoteId];
            thisObj._infoSendServer('del socket ' + thisSendSocket.remoteId);
        });

        thisObj._childSocketMap[sendSo.remoteId] = sendSo;
        thisObj._infoSendServer('add socket ' + sendSo.remoteId);

    });
    this.server.on('close', function () {
        thisObj._emitClose();
    });
    this.server.on('error', function (err) {
        thisObj._errorSendServer('err=' + err);
        thisObj._emitClose();
    });

    this.server.listen(this._param.port);
    this._infoSendServer('start port:' + this._param.port);
};
/**
 * 启动“指令器 vs 执行器”循环
 * 该模式主要是为了将一项大任务分解成许多小任务分次执行，以解决nodejs单进程无法响应高并发的问题，
 * 模式中通过使用js中的setImmediate方法，实现了将小任务以事件的形式交给nodejs进行统一调配处理，
 * 以解决nodejs的单进程高并发的问题。
 * 目前承载的任务：1、开始循环推送sender实例中消息队列中的所有消息，直至消息推送完毕后关闭循环，
 */
YSendServer.prototype.startCmdAndExec = function () {
    var thisObj = this;
    var timeout = thisObj._param.sendMsgStartLate;
    thisObj._infoSendServer('《cmd VS exe》 recursion will launch in %s second...', timeout/1000);
    setTimeout(function () {
        thisObj._startComander.call(thisObj, null);
        thisObj._infoSendServer('《cmd VS exe》 begin...');
    }, timeout);
};

/**
 * 启动命令器，命令器内部会启动执行器
 */
YSendServer.prototype._startComander = function (cmdRtn) {
    var thisObj = this;
    // handle cmdRtn
    if(cmdRtn && cmdRtn.type==ECmdType.errRtn) {
        thisObj._warnSendServer('error encountered, 《cmd VS exe》 end with cmdRtn=%j!', cmdRtn);
        return;
    }
    // new recursion
    thisObj._debugSendServer('start comander, cmdRtn=%j', cmdRtn);
    var sendCmd = null;
    var comderRunning = null;
    if (thisObj._msgPushAddsQueue.length > 0) { // 判断发送信息数组的长度（这里可以调整各个任务的优先级）
        thisObj._debugSendServer('there are msg need to be sent in msgArr=%j', thisObj.msgArr);
        sendCmd = new YCmdMsg(ECmdType.cmdSendMsg, null);// 如果长度大于0 说明有消息要推送  ECmdType.cmdSendMsg 代码3
        comderRunning = true;
    } else {
        thisObj._infoSendServer('no task to execute, 《cmd VS exe》 end!');
        comderRunning = false;
    }
    if (comderRunning) {
        setImmediate(function () {
            thisObj._startExecutor.call(thisObj, sendCmd); // 执行来自命令器的命令
        });
    }
};

/**
 * 启动执行器，检测是否有msgPushAdds要发送，有则发送给gpns-sender连接来的socket
 */
YSendServer.prototype._startExecutor = function (cmd) {
    var thisObj = this;
    thisObj._traceSendServer('start executor with cmd.type = %s', cmd.type);
    var sendCmdRtn = null; // 执行器执行完成之后的指令状态
    try {
        if (cmd.type == ECmdType.cmdSendMsg) {
            thisObj._debugSendServer('start executor cmdSendMsg');
            thisObj._handleMsgPushAddsQueue();
            sendCmdRtn = new YCmdMsg(ECmdType.cmdSendMsgRtn, null); // 消息发送完毕之后更改状态 ECmdType.cmdSendMsgRtn 5  executor发送消息完毕，通知commander
        } else {
            thisObj._debugSendServer('no matched executor start');
            sendCmdRtn = new YCmdMsg(ECmdType.errRtn, null);  //**否则 消息代码为0
        }
    } catch (err) {
        thisObj._errorSendServer('executor data err = %s', err.stack); // 向日志里面写错误信息
        sendCmdRtn = new YCmdMsg(ECmdType.errRtn, null);
    }

    var thisObj = this;
    setImmediate(function () {
        thisObj._startComander.call(thisObj, sendCmdRtn);
    });
};
/**
 * 处理this._msgPushAddsQueue消息队列里的一条消息
 * @private
 */
YSendServer.prototype._handleMsgPushAddsQueue = function () {
    var pushAdds = this._msgPushAddsQueue[0].pushAdds;
    var msgPushAdds = new Object();
    msgPushAdds.msg = this._msgPushAddsQueue[0].msg;
    msgPushAdds.pushAdds = new Array();
    msgPushAdds.expiredTime = this._msgPushAddsQueue[0].expiredTime;

    for (var i = 0; i < this._param.sendMsgToPushAddsPer && pushAdds.length > 0; i++) {
        var pushAdd = pushAdds.shift();
        msgPushAdds.pushAdds.push(pushAdd);
    }
    // push msg to user's message queues stored in memcached
    redisClient.addPendingMsg(msgPushAdds, null);
    this._sendToSockets(msgPushAdds);

    if (pushAdds.length == 0) {
        this._msgPushAddsQueue.shift();
    }
};
/**
 * 将msgPushAdds发送给gpns-sender连接来的socket
 * @param msgPushAdds json格式为{'msg':..,'pushAdds':['pushAdd1','pushAdd2',...]}
 */
YSendServer.prototype._sendToSockets = function (msgPushAdds) {
    for (var key in this._childSocketMap) {
        this._childSocketMap[key].send(JSON.stringify(msgPushAdds) + UData.endChar);
    }
};

YSendServer.prototype._logSendServer = function () {
    this.loggerStack1.log(util.format('gpns-sender send[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YSendServer.prototype._traceSendServer = function () {
    this.loggerStack1.trace(util.format('gpns-sender send[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YSendServer.prototype._debugSendServer = function () {
    this.loggerStack1.debug(util.format('gpns-sender send[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YSendServer.prototype._infoSendServer = function () {
    this.loggerStack1.info(util.format('gpns-sender send[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YSendServer.prototype._warnSendServer = function () {
    this.loggerStack1.warn(util.format('gpns-sender send[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YSendServer.prototype._errorSendServer = function () {
    this.loggerStack1.error(util.format('gpns-sender send[%s]: %s', process.pid, this.format.apply(null, arguments)));
};

exports.YSendServer = YSendServer;