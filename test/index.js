const assert = require('assert');

// Setup global state
global.config = {
    general: { network: 'stagenet' },
};

describe('common', function () {
    describe('#tryParseMergeMiningAddress()', function () {
        const { tryParseMergeMiningAddress } = require('../lib/common');
        it('returns address parts if valid', function () {
            const address =
                '06b9998a8a6001ab17f359cd1371b78e1930f3d99d30f97d93889e3ca664ff2f:51skQCSE9dAJjWPe6RWojZ536oQHMLUYxZPei3B32YLTcdEX37X6xBR1PFwA3hmYciNz4kpC3cuuy6XH8SQV7f5E5AnKQkF';
            const { tari, monero } = tryParseMergeMiningAddress(address);
            assert.strictEqual(tari, '06b9998a8a6001ab17f359cd1371b78e1930f3d99d30f97d93889e3ca664ff2f');
            assert.strictEqual(
                monero,
                '51skQCSE9dAJjWPe6RWojZ536oQHMLUYxZPei3B32YLTcdEX37X6xBR1PFwA3hmYciNz4kpC3cuuy6XH8SQV7f5E5AnKQkF',
            );
        });

        it('errors if no delimiter', function () {
            const address =
                '06b9998a8a6001ab17f359cd1371b78e1930f3d99d30f97d93889e3ca664ff2f_51skQCSE9dAJjWPe6RWojZ536oQHMLUYxZPei3B32YLTcdEX37X6xBR1PFwA3hmYciNz4kpC3cuuy6XH8SQV7f5E5AnKQkF';
            assert.throws(() => {
                tryParseMergeMiningAddress(address);
            });
        });

        it('errors if invalid tari address', function () {
            const address =
                'z6b9998a8a6001ab17f359cd1371b78e1930f3d99d30f97d93889e3ca664ff2f:51skQCSE9dAJjWPe6RWojZ536oQHMLUYxZPei3B32YLTcdEX37X6xBR1PFwA3hmYciNz4kpC3cuuy6XH8SQV7f5E5AnKQkF';
            assert.throws(() => {
                tryParseMergeMiningAddress(address);
            });
        });

        it('errors if invalid monero address', function () {
            const address =
                '06b9998a8a6001ab17f359cd1371b78e1930f3d99d30f97d93889e3ca664ff2f:61skQCSE9dAJjWPe6RWojZ536oQHMLUYxZPei3B32YLTcdEX37X6xBR1PFwA3hmYciNz4kpC3cuuy6XH8SQV7f5E5AnKQkF';
            assert.throws(() => {
                tryParseMergeMiningAddress(address);
            });
        });
    });
});
