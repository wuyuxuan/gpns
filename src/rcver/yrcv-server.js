/**************************************************************************
 * <p>Title: 类列表YRcvServer YMsg EMsgStatus</p>
 * <p>Description: gpns-rcver接收服务,基于http，用于接收msg及pushAdds</p>

 * @author   shifengxuan
 * @version  1.00
 * @date     2013-12-18
 ***************************************************************************/

var http = require('http'), url = require('url'), util = require('util');
var cNodeBase = require('../common/cnode-base');

/**
 * gpns-rcver接收服务支持的url列表
 */
var ERcvServerPath = {
    msgPush: '/gpns/msg/push.do'			// 接收推送的msgPushAdds
};

/**
 * 基于http的接收msg及pushAdds的服务，将接收到msgPushAdds放到msgPushAddsQueue中
 *@param sendSvr rcv-server依赖于send-server，rcv-server接收到消息后，需要启动send-server的循环任务，以推送消息
 * @param msgPushAddsQueue
 * @param port
 * @constructor
 */
function YRcvServer(sendSvr, msgPushAddsQueue, port) {
    this.server = null;
    this._sendSvr = sendSvr;    // 对send-server对象实例的引用
    this._msgPushAddsQueue = msgPushAddsQueue;	// 将接收到的msgPushAdds放到此变量中
    this._port = port;
    this._onClose = null;
}

util.inherits(YRcvServer, cNodeBase.CNodeBase);

/**
 * 启动服务
 */
YRcvServer.prototype.start = function () {
    var thisObj = this;

    this.server = http.createServer();
    this.server.on('request', function (req, res) {
        var pathname = url.parse(req.url).pathname;
        if (pathname == ERcvServerPath.msgPush) {
            thisObj._handMsgPush(req, res);
        } else {
            thisObj._resWrite(res, 404, new YMsg(EMsgStatus.failure, 'page not found', null));
        }
    });
    this.server.on('close', function () {
        thisObj._emitClose();
    });
    this.server.on('error', function (err) {
        thisObj._errorRcvServer('err=' + err);
        thisObj._emitClose();
    });

    this.server.listen(this._port);

    this._infoRcvServer('start port: %s', this._port);
};

/**
 * 关闭服务
 */
YRcvServer.prototype.close = function () {
    if (this.server) this.server.close();
};

/**
 * 服务关闭时，调用此函数
 */
YRcvServer.prototype._emitClose = function () {
    if (this.server) {
        this._errorRcvServer('close');
        this.server = null;
        if (this._onClose) this._onClose();
    }
};

/**
 * 设置关闭事件
 *
 * @param onClose
 */
YRcvServer.prototype.setOnClose = function (onClose) {
    this._onClose = onClose;
};

YRcvServer.prototype._logRcvServer = function () {
    this.loggerStack1.log(util.format('gpns-rcver rcv[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YRcvServer.prototype._traceRcvServer = function () {
    this.loggerStack1.trace(util.format('gpns-rcver rcv[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YRcvServer.prototype._debugRcvServer = function () {
    this.loggerStack1.debug(util.format('gpns-rcver rcv[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YRcvServer.prototype._infoRcvServer = function () {
    this.loggerStack1.info(util.format('gpns-rcver rcv[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YRcvServer.prototype._warnRcvServer = function () {
    this.loggerStack1.warn(util.format('gpns-rcver rcv[%s]: %s', process.pid, this.format.apply(null, arguments)));
};
YRcvServer.prototype._errorRcvServer = function () {
    this.loggerStack1.error(util.format('gpns-rcver rcv[%s]: %s', process.pid, this.format.apply(null, arguments)));
};

/**
 * 处理推送的msgPushAdds
 */
YRcvServer.prototype._handMsgPush = function (req, res) {
    var thisObj = this;
    var body = '';

    req.setEncoding('utf8');

    req.on('data', function (chunk) {
        body += chunk;
    });
    req.on('end', function () {
        thisObj._infoRcvServer('rcv notification: %s', body);
        try {
            var msgPushAdds = JSON.parse(body);
            thisObj._verify(msgPushAdds);
            thisObj._msgPushAddsQueue.push(msgPushAdds);
            thisObj._sendSvr.startCmdAndExec();

            thisObj._resWrite(res, 200, new YMsg(EMsgStatus.success, 'msg push successfully', null));
        } catch (err) {
            thisObj._warnRcvServer('notification rejected!: %s', err.message);
            thisObj._resWrite(res, 200, new YMsg(EMsgStatus.failure, err.message, null));
        }
    });
};

/**
 * 验证接收的msgPushAdds格式是否正确，不正确抛出异常
 *
 * @param msgPushAdds json格式为{'msg':..,'pushAdds':['pushAdd1','pushAdd2',...],'expiredTime':1397721235000}
 */
YRcvServer.prototype._verify = function (msgPushAdds) {
    if (msgPushAdds.msg && msgPushAdds.pushAdds && msgPushAdds.expiredTime) {
        if (!msgPushAdds.pushAdds.length) {
            throw new Error('pushAdds is not array or is empty');
        }
        if(msgPushAdds.expiredTime < new Date().getTime()) {
            throw new Error(util.format('msg expired in %s', new Date(msgPushAdds.expiredTime).format('yyyy-MM-dd HH:mm:ss')));
        }
    } else {
        throw  new Error('msg, pushAdds and expiredTime are all needed!');
    }
};

/**
 * 用res将statusCode, msg写回给客户端
 *
 * @param res
 * @param statusCode
 * @param msg
 */
YRcvServer.prototype._resWrite = function (res, statusCode, msg) {
    res.writeHead(statusCode, {'Content-Type': 'text/html'});
    var resMsg = msg.encode();
    res.write(resMsg);
    res.end();
    this._infoRcvServer('res msg: %s', resMsg);
};

/**
 * msg status
 */
var EMsgStatus = {
    success: 'SUCCESS',		// 成功
    failure: 'FAILURE',		// 失败
    error: 'ERROR'			// 服务器发送错误
};

/**
 * http返回信息的格式
 *
 * @param status 状态，{@link EMsgStatus}
 * @param msg 返回失败或是成功信息
 * @param data 返回数据
 * @constructor
 */
function YMsg(status, msg, data) {
    this.status = status;
    this.msg = msg;
    this.data = data;
}

/**
 * 获取对象的字符串表示
 *
 * @returns 返回对象的字符串表示
 */
YMsg.prototype.encode = function () {
    return JSON.stringify(this);
};


exports.YRcvServer = YRcvServer;