/**************************************************************************
 * <p>Title: 子进程处理类</p>
 * <p>Description: <li>接收来自主进程的socket
 <li>接收来自gpns-rcver的msg
 <li>发送心跳包
 <li>发送推送消息</p>

 * @author   shifengxuan
 * @version  1.00
 * @date     2013-12-05
 ***************************************************************************/
var net = require('net'), util = require('util');
var YMap = require('../common/ymap').YMap, YDataParser = require('../common/ydata-parser').YDataParser,
    YChannel = require('./ychannel').YChannel, cNodeBase = require('../common/cnode-base'),
    redisClient = require('../common/credis-client').redisClient;

/**
 * 子进程类
 *
 * @param gparam 所需参数
 */
function YChildProcess(gparam) {
    this.chanlQueue = new Array();				// 存储YChannel的队列，用于发送心跳包。每次出队的对象，如果有效，会再次入队
    this.pushAddChanlMap = new YMap();		    // 存储pushAdd-YChannel的map，用于发送msg
    this.gparam = gparam;						    // see GParam in main.js

    this._pid = process.pid + '_' + new Date().getTime();	// 每次启动this._pid一定不会和之前的任何子进程相同
    this._isDestroy = false;
}

util.inherits(YChildProcess, cNodeBase.CNodeBase);
/**
 * 子进程开始
 */
YChildProcess.prototype.start = function () {
    this._infoChild('start _pid=' + this._pid); //**记录子进程信息
    this._startProcessListener();   //**子进程注册的事件

    this._startRcvSocket(); //**启动接收来自主进程的socket

};

/**
 * 写日志，函数的参数可以参考 tracer 模块
 * @private
 */
YChildProcess.prototype._logChild = function () {
    this.loggerStack1.log(util.format('gpns-sender child[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YChildProcess.prototype._traceChild = function () {
    this.loggerStack1.trace(util.format('gpns-sender child[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YChildProcess.prototype._debugChild = function () {
    this.loggerStack1.debug(util.format('gpns-sender child[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YChildProcess.prototype._infoChild = function () {
    this.loggerStack1.info(util.format('gpns-sender child[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YChildProcess.prototype._warnChild = function () {
    this.loggerStack1.warn(util.format('gpns-sender child[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YChildProcess.prototype._errorChild = function () {
    this.loggerStack1.error(util.format('gpns-sender child[%s]: %s', process.pid, this.format.apply(null, arguments)));
};

/**
 * 子进程注册的事件
 */
YChildProcess.prototype._startProcessListener = function () {
    //当前子进程结束，释放资源
    var thisObj = this;
    process.on('exit', function (code, signal) {
        thisObj._errorChild('exit: code: %s, signal: %s', code, signal);
        thisObj._destroy();
    });

    process.on('disconnect', function () {  //与主进程失去联系
        thisObj._errorChild('disconnect');
        thisObj._destroy();
        process.exit(1);
    });

    process.on('uncaughtException', function (err) {	// 处理异步回调中的异常，避免子进程退出
        thisObj._errorChild('err=' + err.stack);
    });
};

/**
 * 启动接收来自主进程的socket
 */
YChildProcess.prototype._startRcvSocket = function () {
    var thisObj = this;
    thisObj._infoChild('executor rcv socket start...');
    process.on('message', function (msg, handler) {
        if (msg == 'socket' && handler && handler._handle) {
            var channel = new YChannel(handler, thisObj.gparam.rcvItvlTimeout, thisObj.gparam.sendHeartbeatItvl, //**时间间隔，每次发送的socket个数
                thisObj.gparam.reconnConf,
                function (thisChannel) {
                    var pushAdd = thisChannel.pushAdd;
                    thisObj._debugChild('new connection register with pushadd: %s', pushAdd);
                    thisObj._delChanlFromChild(pushAdd);
                    thisObj._addChanlToChild(pushAdd, thisChannel);
                    // push pending message
                    thisObj.pushPendingMsg(thisChannel);
                    // socket event
                    handler.on('close', function (data) {
                        thisObj._traceChild('connection close: %s:%s',
                            thisChannel._remoteAddress, thisChannel._remotePort);
                        thisObj._delChanlFromChild(pushAdd);
                        thisObj._socketPoolChecking();
                    });
                    handler.on('error', function (err) {
                        thisObj._traceChild('connection error: %s:%s, err=%s',
                            thisChannel._remoteAddress, thisChannel._remotePort, err.stack);
                        thisObj._delChanlFromChild(pushAdd);
                        thisObj._socketPoolChecking();
                    });
                },
                //**新增检测
                function (thisChannel) {
//                    thisObj._socketPoolChecking();
                }
            );
            thisObj.chanlQueue.push(channel);
        } else {
            if(msg.type == 'pushMsg') {
                thisObj.sendMsg(msg.data);
            }
        }
    });
    // 定时检测socket pool里socket的状态，销毁socket pool里的过期socket
    setInterval(function () {
        thisObj._debugChild('check socket pool by interval');
        thisObj._socketPoolChecking();
    }, 100);
};
/**
 * 检测socket pool里的socket状态
 * @private
 */
YChildProcess.prototype._socketPoolChecking = function () {
    var thisObj = this;
    // 处理过期的socket（由客户端心跳包触发检查工作）
    var num = Math.min(thisObj.chanlQueue.length, thisObj.gparam.checkHeartbeatPer);
    for (var i = 0; i < num; i++) {
        var channel = thisObj.chanlQueue.shift();
        if (channel.isConnected()) {
            thisObj.chanlQueue.push(channel);
        } else {
            thisObj._traceChild('destroy expired socket: pushadd=%s --> %s:%s',
                channel.pushAdd, channel._remoteAddress, channel._remotePort);
            thisObj._delChanlFromChild(channel.pushAdd);
        }
    }
};

/**
 * 释放对象
 */
YChildProcess.prototype._destroy = function () {
    this._isDestroy = true;
};

/**
 * 向channel发送推送消息，被sender的主进程调用
 * @param pushAdds 要推送pushadds
 * @private
 */
YChildProcess.prototype.sendMsg = function (pushAdds) {
    for (var i = 0; i < pushAdds.length > 0; i++) {
        var pushAdd = pushAdds.shift();
        var channel = this.pushAddChanlMap.get(pushAdd);
        if (channel) {
            if (channel.isConnected()) {
                this.pushPendingMsg(channel);
            } else {
                this._delChanlFromChild(channel.pushAdd);
            }
        }
    }
};
/**
 * 推送属于channel的未推送消息
 * @param channel
 */
YChildProcess.prototype.pushPendingMsg = function (channel) {
    var thisObj = this;
    redisClient.getPendingMsgQueue(channel.pushAdd, function (err, msgArr) {
//        thisObj._debugChild('[%s] have pending message queue: %j', channel.pushAdd, msgArr);
        thisObj._infoChild('[%s] get pending message queue from redis: %j', channel.pushAdd, msgArr);
            if(msgArr) {
            var msg = msgArr.shift();
            while(msg) {
                channel.sendNotification(JSON.stringify(msg));
                msg = msgArr.shift();
            }
        }
    }, false);
};
/**
 * 从子进程中删除pushAdd对应的信息
 * @param pushAdd
 */
YChildProcess.prototype._delChanlFromChild = function (pushAdd) {
    var channel = this.pushAddChanlMap.get(pushAdd);
    if (channel) {
        this._traceChild('get old channel[%s:%s] by %s, and destroy it!',
            channel._remoteAddress, channel._remotePort, pushAdd);
        channel.destroy();
    }
    this.pushAddChanlMap.delete(pushAdd);
    this._traceChild('pushAddChanlMap keys: %j', this.pushAddChanlMap.keys());
    process.send(this.pushAddChanlMap.size());	//通知主进程，子进程处理的socket的数量
};
YChildProcess.prototype._addChanlToChild = function (pushAdd, channel) {
    var channel = this.pushAddChanlMap.add(pushAdd, channel);
    this._traceChild('pushAddChanlMap keys: %j', this.pushAddChanlMap.keys());
    process.send(this.pushAddChanlMap.size());	//通知主进程，子进程处理的socket的数量
};

//解析主进程传来的参数
var gParam = JSON.parse(process.argv[2]);
new YChildProcess(gParam).start();
