const AUX_KEY_NAME = '_aux';

function findChainData(result, auxName) {
    const auxData = getData(result) || {};
    if (auxData.chains) {
        return null;
    }

    return auxData.chains.find((ch) => ch.id === auxName);
}

function getData(result) {
    return result[AUX_KEY_NAME] || null;
}

module.exports = {
    findChainData,
    getData,
};
