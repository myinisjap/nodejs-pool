'use strict';

angular.module('pool.globals', [])

.factory('GLOBALS', function() {
	return {
		pool_name: "XMRTariPool.net",
		api_url : 'http://api.xmrtaripool.test',
		api_refresh_interval: 5000,
		app_update_interval: 30*60000
	};
});
