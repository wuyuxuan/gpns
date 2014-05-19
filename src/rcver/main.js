/**************************************************************************
 * <p>Title: gpns-rcver</p>
 * <p>Description: gpns由gpns-rcver及gpns-sender组成，此项目为gpns-rcver
 * 负责接收消息及pushAdd列表，并将消息发送 给gpns-sender的相关子进程</p>

 * @author   shifengxuan
 * @version  1.00
 * @date     2013-12-12
 ***************************************************************************/

var YSendServer = require('./ysend-server').YSendServer,
    YRcvServer = require('./yrcv-server').YRcvServer,
    logger = require('../common/cnode-base').CNodeBase.prototype;

var RCV_SERVER_PORT = 3000;				// 接收msg的http的服务的端口

var SEND_SERVER_PORT = 9000;			// 发送msg给gpns-sender的tcp服务的端口
var SEND_MSG_TO_PUSHADDS_PER = 300;		// 每次发送给gpns-sender的每个子进程的pushAdd的个数
var SEND_MSG_START_LATE = 1000;		// yrcv-server接收到消息后多少ms，开始检测是否有msgPushs要发送，等待的时间供gpns-sender连接

var GStore = {							// 全局共享的数据变量
    msgPushAddsQueue: new Array()		// 存储待处理的msgPushAdds的列表的队列，每次新接收到的msgPushAdds放到队尾
};

var sendSvrParam = {//** 发送消息的一些参数
    port: SEND_SERVER_PORT, //**端口
    sendMsgToPushAddsPer: SEND_MSG_TO_PUSHADDS_PER,  // 每次发送给gpns-sender的每个子进程的pushAdd的个数
    sendMsgStartLate: SEND_MSG_START_LATE   // 多少ms以后，开始循环检测是否有msgPushs要发送，档发送完消息后结束循环
};

function exit() {
    logger.error('gpns-rcver[%s]: exit -1', process.pid);
    process.exit(-1);
}

// 启动服务
var sendSvr = new YSendServer(GStore.msgPushAddsQueue, sendSvrParam);
sendSvr.setOnClose(exit);
sendSvr.start();

var rcvSvr = new YRcvServer(sendSvr, GStore.msgPushAddsQueue, RCV_SERVER_PORT);
rcvSvr.setOnClose(exit);
rcvSvr.start();

process.on('uncaughtException', function (err) {	// 处理异步回调中的异常
    logger.error('gpns-rcver[%s]: err=%s', process.pid, err.stack);
});
