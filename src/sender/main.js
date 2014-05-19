/**************************************************************************
 * <p>Title: gpns-sender</p>
 * <p>Description: gpns由gpns-rcver及gpns-sender组成，此项目为gpns-sender，
 * 负责接收来自gpns-rcver的消息及pushAdd列表，并将消息发送
 * 给pushAdd的移动客户端，此项目开启一个socket服务，用于保
 * 持与移动客户端的连接</p>

 * @author   shifengxuan
 * @version  1.00
 * @date     2013-12-04
 ***************************************************************************/
var net = require('net'), util = require('util');
var cp = require('../common/lib/child_process'), CNodeBase = require('../common/cnode-base.js').CNodeBase;
var YMap = require('../common/ymap').YMap, YDataParser = require('../common/ydata-parser').YDataParser,
    YCmdMsg = require('../common/ycmd-msg').YCmdMsg, ECmdType = require('../common/ycmd-msg').ECmdType;

// global
var PORT = 8000;                                  // gpns-sender port
var CHILD_MAX = 3;                               // 最多可创建子进程的个数
var NEW_CHILD_GT_SOCKET_NUMBER = -1;          // min(子进程处理的socket的个数)>此值 && 子进程的个数<CHILD_MAX ，创建新的子进程
//var GPNS_RCVER_HOST = '127.0.0.1';            // gpns-rcver的ip
var GPNS_RCVER_HOST = '192.168.1.4';            // gpns-rcver的ip
var GPNS_RCVER_PORT = 9000;                     // gpns-rcver的端口号
var GPNS_RCVER_RECONNECT_ITVL = 5000;          // gpns-rcver的连接断掉，每隔多少毫秒重连一次

var RCV_ITVL_TIMEOUT = 120000;                  // 对每个长连接，如果距离上一次接收到此链接数据的时间大于此值认为连接断掉
var SEND_HEARBEAT_ITVL = 30000;                 // 对每个长连接，发送心跳包的时间间隔（心跳包改为客户端发）
var SEND_MSG_TO_PUSHADDS_PER = 200;            // 每次发送推送消息给多少个pushAdd
var CHECK_HEARTBEAT_PER = 200;                  // 每次检测多少个socket
//全局参数
var GParam = {                                    //传递给子进程的参数
    rcvItvlTimeout: RCV_ITVL_TIMEOUT,
    sendHeartbeatItvl: SEND_HEARBEAT_ITVL,
    reconnConf: {       // 对每个长连接，当没有成功设置心跳包时间间隔时，服务器会重新连接并设置客户端
        interval: 5000, // 两次重连的时间间隔（millisecond）
        count: 3        // 重新连接的最大次数
    },
    checkHeartbeatPer: CHECK_HEARTBEAT_PER
};


/**
 * 子进程及处理的socket数量的类<br>
 * @param childProcess  子进程
 * @param socketNumber 处理的socket数量
 */
function YChild(childProcess, sokcetNumber) {
    this.cProcess = childProcess;
    this.soNumber = sokcetNumber;
}

/**
 * 服务类，负责创建socket服务，接收socket连接，创建子进程，将socket连接分发给子进程
 */
function YServer() {
    this.childMap = new YMap();          //子进程列表
    this.server = null;                    //socket服务
    this._rcverSocket = null;           // socket channel between rcver and sender
    this.msgArr = new Array();		   // 存储待发消息的列表，每个待发消息中有其要发送的pushAdd列表
    this._rcverSocketParser = new YDataParser();	  // 缓冲接收的推送信息，每次接收到一个完整的推动信息，则将此条推送信息从此变量中移除

    this._isDestroy = false;
}
// inherits
util.inherits(YServer, CNodeBase);

/**
 * 启动服务
 */
YServer.prototype.start = function () {
    var thisObj = this;
    thisObj._infoServer('start...');
    thisObj._establishChannelWithRcver();
    thisObj._startRcvSocket();
    thisObj._handleException();
};
/**
 * etablish a channel between sender main process and rcver send server, for the following purpose:
 * 1. send msg from rcver;
 * 2. get sender server's status, e.g. socket pool info
 * @private
 */
YServer.prototype._establishChannelWithRcver = function () {
    var thisObj = this;
    var cmdExeRunning = null;
    thisObj._rcverSocket = net.Socket();

    thisObj._rcverSocket.connect(GPNS_RCVER_PORT, GPNS_RCVER_HOST, function () {
        thisObj._infoServer('commander rcv msg connect to gpns-rcver %s:%s', GPNS_RCVER_HOST, GPNS_RCVER_PORT);
        thisObj._rcverSocketAddr = this.localAddress + ':' + this.localPort;
    });

    thisObj._rcverSocket.on('data', function (data) {
        thisObj._debugServer('commander rcv msg = %s', data);
        thisObj._rcverSocketParser.push(data);
        var msgPushAddStr = thisObj._rcverSocketParser.popNextMsg(true);
        while (msgPushAddStr != null) {
            try {
                var msgPushAdd = JSON.parse(msgPushAddStr);		//{"msg":{...},"pushAdds":[...]}
                thisObj._infoServer('get a msg from rcver-sender: %s', data);
                thisObj.msgArr.push(msgPushAdd);
            } catch (err) {
                thisObj._errorServer('err=msg parse error');
            }
            msgPushAddStr = thisObj._rcverSocketParser.popNextMsg(true);
        }

        // TODO  i did some
        thisObj._infoServer('cmdExeRunning = %s', cmdExeRunning);
        if (!cmdExeRunning) {
            thisObj._startComder(null);
        }
        // 检测cmd-exe运行没有，没有运行 --》this._startComder(null); //start cmd-exe
    });

    // exceptoin handling
    thisObj._rcverSocket.on('error', function (err) {
        thisObj._errorServer('commander rcv msg disconnect to gpns-rcver, msg=%s' + err.stack);
    });
    thisObj._rcverSocket.on('close', function () {
        thisObj._errorServer('commander rcv msg disconnect to gpns-rcver, msg=close');
        thisObj._rcverSocket.destroy();
        thisObj._rcverSocket = null;
        thisObj._rcverSocketAddr = null;

        if (!thisObj._isDestroy)
            setTimeout(function () {
                thisObj._establishChannelWithRcver.call(thisObj);
            }, GPNS_RCVER_RECONNECT_ITVL);		// reconnect gpns-rcver when disconnect
    });
};
/**
 * 启动命令器<br>
 * <li>给执行者下达命令：1.发送心跳包；2.发送推送消息
 * @param cmdRtn 命令返回信息，类型YCmdMsg
 */
YServer.prototype._startComder = function (cmdRtn) {
    //start--cmdExeRunning = true end--false
    var thisObj = this;
    thisObj._infoServer('start commder, cmdRtn=%j', cmdRtn);
    var sendCmd = null;
    var comderRunning = null;
    if (thisObj.msgArr.length > 0) {//**判断发送信息数组的长度
        thisObj._infoServer('there are msg need to be sent in msgArr=%j', thisObj.msgArr);
        sendCmd = new YCmdMsg(ECmdType.cmdSendMsg, null);//**如果长度大于0 说明有消息要推送  ECmdType.cmdSendMsg 代码3
        comderRunning = true;
    } else {
        thisObj._infoServer('no task to execute, stop commander');
        comderRunning = false;
    }
    if (comderRunning) {
        setImmediate(function () {
            thisObj._startExecutor.call(thisObj, sendCmd); //**<li>执行来自命令器的命令：1.发送心跳包；3.发送推送消息
        });
    }
};
/**
 * execute task by cmd sent by commander
 * @param cmd
 * @private
 */
YServer.prototype._startExecutor = function (cmd) {
    var thisObj = this; //**这里需要获取到原型的this
    thisObj._infoServer('start executor with cmd.type = %s', cmd.type);
    var sendCmdRtn = null; //记录心跳包发送完成之后状态
    try {
        if (cmd.type == ECmdType.cmdSendMsg) {
            thisObj._infoServer('start executor cmdSendMsg');
            thisObj._sendMsgToChildProcess();  //**调用发送消息的方法
            sendCmdRtn = new YCmdMsg(ECmdType.cmdSendMsgRtn, null);//**消息发送完毕之后更改状态 ECmdType.cmdSendMsgRtn 5  executor发送消息完毕，通知commander
        } else {
            thisObj._infoServer('no matched executor start');
            sendCmdRtn = new YCmdMsg(ECmdType.errRtn, null);  //**否则 消息代码为0
        }
    } catch (err) {
        thisObj._errorServer('executor data err=' + err.stack);//**向日志里面写错误信息
        sendCmdRtn = new YCmdMsg(ECmdType.errRtn, null);
    }

    setImmediate(function () {
        thisObj._startComder.call(thisObj, sendCmdRtn);
    });
};
/**
 * 向所有的child process发送推送消息
 */
YServer.prototype._sendMsgToChildProcess = function () {
    var thisObj = this;
    if (this.msgArr.length > 0) {
        var msg = this.msgArr[0].msg;
        var pushAdds = this.msgArr[0].pushAdds;
        var expiredTime = this.msgArr[0].expiredTime;
        this._infoServer('start sending msg with conf: SEND_MSG_TO_PUSHADDS_PER=%d, pushAdds=%j',
            SEND_MSG_TO_PUSHADDS_PER, pushAdds);
        var finalPushAdds = new Array();
        for (var i = 0; i < SEND_MSG_TO_PUSHADDS_PER && pushAdds.length > 0; i++) {
            finalPushAdds.push(pushAdds.shift());
        }
        this._infoServer('==> finalPushAdds=%j', finalPushAdds);
        thisObj.childMap.foreach(function (key ,child) {
            child.cProcess.send({type: 'pushMsg', data: finalPushAdds});     // 通知子进程推送消息，并将pushadds发送给子进程
        }, null, null);
        if (pushAdds.length == 0) {		// 所有pushAdd推送完毕
            this.msgArr.shift();
        }
    }
};
/**
 * 释放对象
 */
YServer.prototype._destroy = function () {
    var thisObj = this;
    thisObj._isDestroy = true;
    if (thisObj._rcverSocket) {
        thisObj._rcverSocket.destroy();
        thisObj._rcverSocket = null;
    }
};
/**
 * global exception handler
 * @private
 */
YServer.prototype._handleException = function () {
    var thisObj = this;
    process.on('exit', function (code, signal) {
        thisObj._errorServer('exit: code: %s, signal: %s', code, signal);
        thisObj._destroy();
    });
    process.on('disconnect', function () {  //与主进程失去联系
        thisObj._errorServer('disconnect');
        thisObj._destroy();
        process.exit(1);
    });
    process.on('uncaughtException', function (err) {	// 处理异步回调中的异常，避免子进程退出
        thisObj._errorServer('err=' + err.stack);
    });
};
/**
 * start a socket listener to receive client socket
 * @private
 */
YServer.prototype._startRcvSocket = function () {
    var thisObj = this;
    thisObj.server = net.createServer();
    thisObj.server.on('connection', function (socket) {
        thisObj.onConnection(socket);
    });
    thisObj.server.listen(PORT/*, HOST */);

    thisObj.server.on('error', function (err) {    // 服务发生错误，退出主进程
        thisObj._errorServer('err: %s', err.stack);
        process.exit(1);
    });
    thisObj.server.on('close', function (err) {       // 服务端口关闭，退出主进程
        thisObj._errorServer('close: %s', err.stack);
        process.exit(1);
    });
};

YServer.prototype._logServer = function () {  //**写服务器启动时的log信息
    this.loggerStack1.log(util.format('gpns-sender[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YServer.prototype._traceServer = function () {
    this.loggerStack1.trace(util.format('gpns-sender[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YServer.prototype._debugServer = function () {
    this.loggerStack1.debug(util.format('gpns-sender[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YServer.prototype._infoServer = function () {
    this.loggerStack1.info(util.format('gpns-sender[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YServer.prototype._warnServer = function () {
    this.loggerStack1.warn(util.format('gpns-sender[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YServer.prototype._errorServer = function () {
    this.loggerStack1.error(util.format('gpns-sender[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
/**
 * 处理socket
 */
YServer.prototype.onConnection = function (socket) {
    //socket.on('close', function(data) {});
    var thisObj = this;
    thisObj._traceServer('new socket connected: %s:%s', socket.remoteAddress, socket.remotePort);
    var child = thisObj.getLightChild();
    var lightProcess = null;
    if (child) lightProcess = child.cProcess;

    if (thisObj.childMap.size() == 0 || (thisObj.childMap.size() < CHILD_MAX && child.soNumber > NEW_CHILD_GT_SOCKET_NUMBER)) {
        var cProcess = thisObj.createChild('./child', GParam);   // 创建新的子进程
        thisObj.addChild(cProcess);
        thisObj._infoServer('child[' + cProcess.pid + '] add');
        cProcess.on('message', function (soNumber) {
            thisObj.getChild(this.pid).soNumber = soNumber;
            thisObj._traceServer('socket pool distribution: %j', thisObj.getChildSocketPool());
        });
        cProcess.on('exit', function (code, signal) {
            thisObj._errorServer('child[' + cProcess.pid + '] exit');
            thisObj.deleteChild(this);
        });
        cProcess.on('disconnect', function (code, signal) {
            thisObj._errorServer('child[' + cProcess.pid + '] disconnect');
            thisObj.deleteChild(this);
        });
        cProcess.on('error', function (err) {
            thisObj._errorServer('child[' + cProcess.pid + '] err=' + err);
        });
        lightProcess = cProcess;
        child = thisObj.getChild(lightProcess.pid);
    }

    child.soNumber += 1;

    lightProcess.send('socket', socket);  // 将接收到的socket发送给子进程
};

/**
 * 找到负载最小(即处理的socket连接最少)的子进程
 */
YServer.prototype.getLightChild = function () {
    var r = null;
    var minSoNumber = Number.MAX_VALUE;
    var c = null;
    this.childMap.foreach(function (key, value, map) {
        if (value.soNumber <= minSoNumber) {
            minSoNumber = value.soNumber;
            r = value;
        }
    }, null, null);
    return r;
};
/**
 * 统计socket池内所有socket的数量总和（即所有子进程的socket数量总和）
 */
YServer.prototype.getChildSocketPool = function () {
    var arr = [];
    var total = 0;
    this.childMap.foreach(function (key, value, map) {
        var child = {};
        child.pid = key;
        child.soNumber = value.soNumber;
        arr.push(child);
        total += value.soNumber;
    }, null, null);
    var ret = {pool: arr, total: total};
    return ret;
};

/**
 * 根据进程id创建key
 *
 * @param pid 进程id
 */
YServer.prototype.getChildKey = function (pid) {
    return pid + '_id';
};

/**
 * 根据进程id找到对应的子进程
 *
 * @param pid 进程id
 */
YServer.prototype.getChild = function (pid) {
    var key = this.getChildKey(pid);
    return this.childMap.get(key);
};

/**
 * 向进程列表中添加子进程
 *
 * @param childProcess 要添加的子进程
 */
YServer.prototype.addChild = function (childProcess) {
    var key = this.getChildKey(childProcess.pid);
    this.childMap.add(key, new YChild(childProcess, 0));
};
/**
 * 从进程列表中删除子进程
 *
 * @param childProcess 要删除的子进程
 */
YServer.prototype.deleteChild = function (childProcess) {
    var key = this.getChildKey(childProcess.pid);
    var c = this.childMap.get(key);
    if (c) {
        this.childMap.delete(key);
    }
};
YServer.prototype.checkSocketPool = function () {
    // 定时检测main管理的所有child process中的socket pool状态
    setInterval(function () {
        server._infoServer('socket pool: %j', server.getChildSocketPool());
    }, 10000);
};

// 启动服务
var server = new YServer();
server.start();

server.checkSocketPool();

