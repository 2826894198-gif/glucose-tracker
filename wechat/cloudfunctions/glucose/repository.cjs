'use strict';

const { COLLECTIONS } = require('./service.cjs');

function missingDocument(error) {
  return error && (['DOCUMENT_NOT_FOUND', 'DATABASE_DOCUMENT_NOT_EXIST'].includes(error.code) || /\bdocument(?: with _id [^\n]*?)?\s+(?:not exists?|does not exist|not found)\b|文档不存在/i.test(typeof error === 'string' ? error : String(error.errMsg || error.message || '')));
}
async function getDocument(scope, collection, id) {
  try {
    const result = await scope.collection(collection).doc(id).get();
    const data = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!data || typeof data !== 'object' || !Object.keys(data).length) return null;
    const { _id: _databaseId, ...value } = data;
    return value;
  } catch (error) {
    if (missingDocument(error)) return null;
    throw error;
  }
}
function transactional(scope) {
  return {
    getAccount: id => getDocument(scope, COLLECTIONS.accounts, id),
    putAccount: (id, value) => scope.collection(COLLECTIONS.accounts).doc(id).set({ data: value }),
    getRecord: id => getDocument(scope, COLLECTIONS.records, id),
    putRecord: (id, value) => scope.collection(COLLECTIONS.records).doc(id).set({ data: value }),
    getOperation: id => getDocument(scope, COLLECTIONS.operations, id),
    putOperation: (id, value) => scope.collection(COLLECTIONS.operations).doc(id).set({ data: value }),
  };
}
function createRepository(database) {
  return {
    // The pinned SDK returns the callback value directly; accept wrapped results
    // too for compatible adapters, without leaking the underlying SDK response.
    async runTransaction(callback) {
      const result = await database.runTransaction(tx => callback(transactional(tx)));
      return result && Object.hasOwn(result, 'result') ? result.result : result;
    },
    getRecord: id => getDocument(database, COLLECTIONS.records, id),
    async listRecords(owner, lower, upper, limit) {
      const command = database.command;
      const result = await database.collection(COLLECTIONS.records)
        .where({ ownerKey: owner, syncVersion: command.gt(lower).and(command.lte(upper)) })
        .orderBy('syncVersion', 'asc').limit(limit).get();
      return result.data.map(({ _id, ...record }) => record);
    },
  };
}

module.exports = { createRepository, missingDocument };
