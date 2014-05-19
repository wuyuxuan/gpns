/**************************************************************************
 * <p>Title: test case for rcver's API</p>
 * <p>Description: a test case for rcver's API</p>
 * @author   wubinhong
 * @version  1.0.0
 * @date     2014-04-13
 ***************************************************************************/
var http = require('http'), util = require('util'), fs = require('fs');
var cNodeBase = require('../common/cnode-base');

/**
 * 构造函数
 * @constructor
 */
function APIRcver(rcvServerIp, rcvServerPort) {
    this.RCV_SERVER_IP = rcvServerIp;
    this.RCV_SERVER_PORT = rcvServerPort;
    this.RCV_SERVER_PATH_MSG_PUSH = '/gpns/msg/push.do';
}
util.inherits(APIRcver, cNodeBase.CNodeBase);

/**
 * 推送消息
 * @param query 例子：'{"msg":{"id":1234,"type":1,"title":"天气提醒","content":"今天晴天，适合出游","detail":"<a>http:www.google.com</a>"},"pushAdds":["pushadd0","pushadd1","pushadd2","pushadd3"],"expiredTime":1397721235000}'
 */
APIRcver.prototype.pushMsg = function (query) {
    var thisObj = this;
    var options = {
        headers: {
            'custom': 'Custom Header Demo works'
        },
        method: 'POST',
        host: thisObj.RCV_SERVER_IP,
        port: thisObj.RCV_SERVER_PORT,
        path: thisObj.RCV_SERVER_PATH_MSG_PUSH
    };
    var req = http.request(options, function (resp) {
        var str = '';
        resp.on('data', function (chunk) {
            str += chunk;
        });
        resp.on('end', function (chunk) {
            thisObj.info(str);
        });
    });
    thisObj.info('==> [%s:%s%s]: %s', thisObj.RCV_SERVER_IP, thisObj.RCV_SERVER_PORT,
        thisObj.RCV_SERVER_PATH_MSG_PUSH, query);
    req.write(query);
    req.end();
};
/**
 * 批量测试GPNS的消息推送接口
 */
APIRcver.prototype.pushBatch = function () {
    var thisObj = this;
    var query = {
        msg: {
            "id": 1234, "type": 1, "title": "天气提醒", "content": util.format('【%s】-格格哟，今天晴天，适合出游', new Date()),
            "detail": "<a>http:www.google.com</a>"
        },
        pushAdds: [],
        "expiredTime": 1400382000000
    }
    var delay = 0;
    for (var k = 0; k < 500; k += 300) {
        query.pushAdds.length = 0   // empty the array
        for (var i = k; i < k + 300; i++) {
            query.pushAdds.push("pushadd" + i);
        }
        thisObj.pushMsg(JSON.stringify(query));
    }
};
/**
 * 向指定pushadds推送一条测试消息
 * @param pushAdds {Array} 要推送的pushaAdds列表
 */
APIRcver.prototype.push = function (pushAdds) {
    // single message
    var query = {
        msg: {
            "id": 1237, "type": 1, "title": "天气提醒哦", "content": util.format('【%s】-格格哟，今天晴天，适合出游', new Date()),
            "detail": "<a>http:www.google.com</a>"
        },
        pushAdds: pushAdds,
        "expiredTime": 1400306400000
    }
    this.pushMsg(JSON.stringify(query));
}
/**
 * 启动程序
 */
APIRcver.prototype.start = function () {
    // push a test msg to pushadds
//    this.push(['042814063319901']);
    // batch message push
    this.pushBatch();
};
// 启动
new APIRcver('103.224.234.108', 3000).start();
//new APIRcver('127.0.0.1', 3000).start();