const { Map, List } = require('immutable')
const { copyObject } = require('../src/common')
const OpSet = require('./op_set')
const { SkipList } = require('./skip_list')
const { splitContainers, encodeChange, decodeChanges, encodeDocument, constructPatch } = require('./columnar')
const assert = require('assert')

function inspect(val) {
    var util = require('util');
    console.log(util.inspect(val, false,10,true));
}

function backendState(backend) {
  if (backend.frozen) {
    throw new Error(
      'Attempting to use an outdated Automerge document that has already been updated. ' +
      'Please use the latest document state, or call Automerge.clone() if you really ' +
      'need to use this old document state.'
    )
  }
  return backend.state
}

/**
 * Mutates the operations in `change` to include the opIds of prior value
 * operations on the appropriate properties in `opSet`.
 */
function fillInPred(opSet, change) {
  let myOps = {} // maps objectId => key => opId
  change.ops.forEach((op, index) => {
    const opId = `${change.startOp + index}@${change.actor}`
    const key = op.insert ? opId : op.key

    if (myOps[op.obj] && myOps[op.obj][key]) {
      op.pred = [myOps[op.obj][key]]
    } else {
      const fieldOps = OpSet.getFieldOps(opSet, op.obj, key)
      op.pred = fieldOps.map(fieldOp => fieldOp.get('opId')).toJS()
    }

    if (!myOps[op.obj]) myOps[op.obj] = {}
    if (!myOps[op.obj][key]) myOps[op.obj][key] = opId
  })
}

/**
 * Processes a change request `request` that is incoming from the frontend. Translates index-based
 * addressing of lists into identifier-based addressing used by the CRDT, translates temporary
 * objectIds into operationId-based identifiers, and removes duplicate assignments to the same
 * object and key. `opSet` corresponds to the version of the document on top of which the frontend
 * made its change (which may lag behind the backend, because there might be remote changes that
 * the backend has already applied, but that the frontend has not yet seen).
 */
function processChangeRequest(state, opSet, request, startOp, incomingChange) {
  const { actor, seq, deps, time, message } = request
  const change = { actor, seq, startOp, deps, time, message, ops: [] }

  let objectIds = state.get('objectIds'), objectTypes = {}, elemIds = {}, assignments = {}
  for (let op of request.ops) {
    const opId = `${startOp + change.ops.length}@${actor}`
    op = copyObject(op)

    if (objectIds.has(op.obj)) {
      op.obj = objectIds.get(op.obj)
    }
    if (op.action === 'link' && objectIds.has(op.child)) {
      op.child = objectIds.get(op.child)
    }

    const objType = objectTypes[op.obj] || opSet.getIn(['byObject', op.obj, '_init', 'action'])

    // The objectId generated by the frontend is temporary, and we map it into an operation ID.
    if (op.action.startsWith('make')) {
      objectIds = objectIds.set(op.child, opId)
      delete op.child
      objectTypes[opId] = op.action
    }

    if (objType === 'makeList' || objType === 'makeText') {
      if (!elemIds[op.obj]) {
        elemIds[op.obj] = opSet.getIn(['byObject', op.obj, '_elemIds']) || new SkipList()
      }
      if (typeof op.key !== 'number') {
        throw new TypeError(`Unexpected operation key: ${op.key}`)
      }

      if (op.insert) {
        if (op.key === 0) {
          op.key = '_head'
          elemIds[op.obj] = elemIds[op.obj].insertAfter(null, opId)
        } else {
          op.key = elemIds[op.obj].keyOf(op.key - 1)
          elemIds[op.obj] = elemIds[op.obj].insertAfter(op.key, opId)
        }
      } else {
        op.key = elemIds[op.obj].keyOf(op.key)
        if (op.action === 'del') {
          elemIds[op.obj] = elemIds[op.obj].removeKey(op.key)
        }
      }
    }

    // Detect duplicate assignments to the same object and key
    if (['set', 'del', 'link', 'inc'].includes(op.action) && !op.insert) {
      if (!assignments[op.obj]) {
        assignments[op.obj] = {[op.key]: op}
      } else if (!assignments[op.obj][op.key]) {
        assignments[op.obj][op.key] = op
      } else if (op.action === 'inc') {
        assignments[op.obj][op.key].value += op.value
        continue
      } else {
        assignments[op.obj][op.key].action = op.action
        assignments[op.obj][op.key].value = op.value
        continue
      }
    }

    change.ops.push(op)
  }

  return [state.set('objectIds', objectIds), change]
}

/**
 * Returns an empty node state.
 */
function init() {
  const opSet = OpSet.init(), versionObj = Map({version: 0, localOnly: true, opSet})
  const state = Map({opSet, versions: List.of(versionObj), objectIds: Map()})
  return {state}
}

function clone(backend) {
  return {state: backendState(backend)}
}

function free(backend) {
  backend.state = null
  backend.frozen = true
}

/**
 * Constructs a patch object from the current node state `state` and the
 * object modifications `diffs`.
 */
function makePatch(state, diffs, request, isIncremental) {
  const version = state.get('versions').last().get('version')
  const clock   = state.getIn(['opSet', 'states']).map(seqs => seqs.size).toJSON()
  const deps    = state.getIn(['opSet', 'deps']).toJSON().sort()
  const maxOp = state.getIn(['opSet', 'maxOp'], 0)
  const patch = {version, clock, deps, diffs, maxOp}

  if (isIncremental && request) {
    patch.actor = request.actor
    patch.seq   = request.seq
  }
  return patch
}

/**
 * The implementation behind `applyChanges()`, `applyLocalChange()`, and
 * `loadChanges()`.
 */
function apply(state, changes, request, isIncremental) {
  let diffs = isIncremental ? {} : null
  let opSet = state.get('opSet')
  for (let change of changes) {
    for (let chunk of splitContainers(change)) {
      if (request) {
        opSet = OpSet.addLocalChange(opSet, chunk, diffs)
      } else {
        opSet = OpSet.addChange(opSet, chunk, diffs)
      }
    }
  }

  OpSet.finalizePatch(opSet, diffs)
  state = state.set('opSet', opSet)

  if (isIncremental) {
    const version = state.get('versions').last().get('version') + 1
    const versionObj = Map({version, localOnly: true, opSet})
    state = state.update('versions', versions => versions.push(versionObj))
  } else {
    const versionObj = Map({version: 0, localOnly: true, opSet})
    state = state.set('versions', List.of(versionObj))
  }

  return [state, isIncremental ? makePatch(state, diffs, request, true) : null]
}

/**
 * Applies a list of `changes` from remote nodes to the node state `backend`.
 * Returns a two-element array `[state, patch]` where `state` is the updated
 * node state, and `patch` describes the modifications that need to be made
 * to the document objects to reflect these changes.
 */
function applyChanges(backend, changes) {
  let state = backendState(backend), patch

  // The localOnly flag on a version object is set to true if all changes since that version have
  // been local changes. Since we are applying a remote change here, we have to set that flag to
  // false on all existing version objects.
  state = state.update('versions', versions => versions.map(v => v.set('localOnly', false)))
  ;[state, patch] = apply(state, changes, null, true)
  backend.frozen = true
  return [{state}, patch]
}

/**
 * Takes a single change request `request` made by the local user, and applies
 * it to the node state `backend`. Returns a two-element array `[backend, patch]`
 * where `backend` is the updated node state, and `patch` confirms the
 * modifications to the document objects.
 */
function applyLocalChange(backend, request, incomingChange) {
  let state = backendState(backend)
  if (typeof request.actor !== 'string' || typeof request.seq !== 'number') {
    throw new TypeError('Change request requries `actor` and `seq` properties')
  }
  if (typeof request.time !== 'number') {
    throw new TypeError('Change request requires `time` property')
  }
  // Throw error if we have already applied this change request
  if (request.seq <= state.getIn(['opSet', 'states', request.actor], List()).size) {
    throw new RangeError('Change request has already been applied')
  }

  const versionObj = state.get('versions').find(v => v.get('version') === request.version)
  if (!versionObj) {
    throw new RangeError(`Unknown base document version ${request.version}`)
  }
  request.deps = versionObj.getIn(['opSet', 'deps']).toJSON()

  const startOp = versionObj.getIn(['opSet', 'maxOp'], 0) + 1
  const [state1, change] = processChangeRequest(state, versionObj.get('opSet'), request, startOp, incomingChange)

  fillInPred(versionObj.get('opSet'), change)

  if (request.requestType === 'change' && incomingChange) {
    change.deps.sort();
    incomingChange.deps.sort();
    assert.deepStrictEqual(change, incomingChange);
  }

  const binaryChange = encodeChange(change)
  const [state2, patch] = apply(state1, [binaryChange], request, true)

  const state3 = state2.update('versions', versions => {
    // Remove any versions before the one referenced by the current request, since future requests
    // will always reference a version number that is greater than or equal to the current
    return versions.filter(v => v.get('version') >= request.version)
      // Update the list of past versions so that if a future change request from the frontend
      // refers to one of these versions, we know exactly what state the frontend was in when it
      // made the change. If there have only been local updates since a given version, then the
      // frontend is in sync with the backend (since the frontend has applied the same change
      // locally). However, if there have also been remote updates, then we construct a special
      // opSet that contains only the local changes but excludes the remote ones. This opSet should
      // match the state of the frontend (which has not yet seen the remote update).
      .map(v => {
        if (v.get('localOnly')) {
          return v.set('opSet', state2.get('opSet'))
        } else {
          return v.set('opSet', OpSet.addLocalChange(v.get('opSet'), binaryChange, null))
        }
      })
  })
  backend.frozen = true
  return [{state: state3}, patch]
}

/**
 * Returns the state of the document serialised to an Uint8Array.
 */
function save(backend) {
  return encodeDocument(getChanges(backend, []))
}

/**
 * Loads the document and/or changes contained in an Uint8Array, and returns a
 * backend initialised with this state.
 */
function load(data) {
  // Reconstruct the original change history that created the document.
  // It's a bit silly to convert to and from the binary encoding several times...!
  const binaryChanges = decodeChanges([data]).map(encodeChange)
  return loadChanges(init(), binaryChanges)
}

/**
 * Applies a list of `changes` to the node state `backend`, and returns the updated
 * state with those changes incorporated. Unlike `applyChanges()`, this function
 * does not produce a patch describing the incremental modifications, making it
 * a little faster when loading a document from disk. When all the changes have
 * been loaded, you can use `getPatch()` to construct the latest document state.
 */
function loadChanges(backend, changes) {
  const state = backendState(backend)
  const [newState, _] = apply(state, changes, null, false)
  backend.frozen = true
  return {state: newState}
}

/**
 * Returns a patch that, when applied to an empty document, constructs the
 * document tree in the state described by the node state `backend`.
 */
function getPatch(backend) {
  const state = backendState(backend)
  const diffs = constructPatch(save(backend))
  return makePatch(state, diffs, null, false)
}

function getChanges(backend, haveDeps) {
  if (!Array.isArray(haveDeps)) {
    throw new TypeError('Pass an array of hashes to Backend.getChanges()')
  }
  const state = backendState(backend)
  return OpSet.getMissingChanges(state.get('opSet'), List(haveDeps))
}

function getMissingDeps(backend) {
  const state = backendState(backend)
  return OpSet.getMissingDeps(state.get('opSet'))
}

module.exports = {
  init, clone, free, applyChanges, applyLocalChange, save, load, loadChanges, getPatch,
  getChanges, getMissingDeps
}
