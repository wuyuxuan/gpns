var cNodeUtil = require('../common/cnode-base.js').cNodeUtil,
    logger = cNodeUtil.logger;

var GParam = {
    start: 0,    //每个socket对应的pushAdd='pushadd'+number，number的起止值=start
    limit: 200,     // 每个进程产生多少个socket
//    GPNS_SENDER_IP: '127.0.0.1',
    GPNS_SENDER_IP: '192.168.1.4',
    GPNS_SENDER_PORT: 8000
};

for (var i = 0; i < 5; i++) {

    var cProcess = cNodeUtil.createChild('./tmobileclient-child.js', GParam);   // 创建新的子进程
    GParam.start += GParam.limit;

    cProcess.on('message', function (data) {
        logger.info(this.pid + ':' + data);
    });
    cProcess.on('exit', function (code, signal) {
        logger.error('child[' + this.pid + '] exit');
    });
    cProcess.on('disconnect', function (code, signal) {
        logger.warn('child[' + this.pid + '] disconnect');
    });
    cProcess.on('error', function (err) {
        logger.error('child[' + this.pid + '] err=' + err.stack);
    });
}
