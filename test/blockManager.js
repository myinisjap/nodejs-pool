Object.assign(global, {
    __dontRunBlockManager: true,
    config: {
        general: { network: 'stagenet' },
    },
});

let blockManager = require('../lib/blockManager');

describe('blockManager', () => {
    it('works', async () => {
        await blockManager.unlockAuxBlocks('xtr');
    });
});
