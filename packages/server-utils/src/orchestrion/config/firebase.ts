import type { InstrumentationConfig } from '@apm-js-collab/code-transformer';

// firebase 9+ ships firestore as `@firebase/firestore` (matches the OTel integration's range). Only the
// `lite` SDK exposes the free `addDoc`/`getDocs`/`setDoc`/`deleteDoc` functions we trace, and only the
// two `node` entry points (CJS `require`, ESM `import`) are reachable from `@sentry/node`; the
// browser/react-native builds are irrelevant here. They return promises, so `Auto` settles the span on
// `asyncEnd`.
//
// Where those declarations live moves with the firestore version, so we register two disjoint ranges
// below. Up to 4.10 they are top-level `function <name>` declarations in the `node` entry files. From 4.10
// the lite build code-splits them into a single content-hashed shared chunk (`common-<hash>.node.*`) and
// leaves the entry files re-export-only, so we match the chunk by a regex on its hashed name. The ranges
// must not overlap: matching the re-export-only entry file would make orchestrion throw "failed to find
// injection points". Regex `filePath` matching requires the code-transformer (orchestrion) >=0.17.0.
const FIRESTORE_OPERATIONS = [
  { functionName: 'addDoc', channelName: 'add-doc' },
  { functionName: 'getDocs', channelName: 'get-docs' },
  { functionName: 'setDoc', channelName: 'set-doc' },
  { functionName: 'deleteDoc', channelName: 'delete-doc' },
] as const;
const FIRESTORE_ENTRY_FILES = ['dist/lite/index.node.cjs.js', 'dist/lite/index.node.mjs'];
const FIRESTORE_CHUNK_FILES = [/^dist\/lite\/common-[^/]+\.node\.cjs\.js$/, /^dist\/lite\/common-[^/]+\.node\.mjs$/];

// firebase-functions v2 (CJS-only). The `onX` provider functions *register* a handler and return a
// synchronous cloud function, so `Sync` is required — the span itself is opened later, when the handler
// runs, by rewrapping the handler argument in the channel's `start` (see `./firebase/functions`). One
// channel per faas trigger so the subscriber knows the trigger type without inspecting arguments.
const FUNCTIONS_VERSION_RANGE = '>=6.0.0 <7';
const FUNCTIONS_TRIGGERS = [
  { file: 'lib/v2/providers/https.js', functionName: 'onRequest', channelName: 'http-request' },
  { file: 'lib/v2/providers/https.js', functionName: 'onCall', channelName: 'http-call' },
  { file: 'lib/v2/providers/firestore.js', functionName: 'onDocumentCreated', channelName: 'firestore-created' },
  {
    file: 'lib/v2/providers/firestore.js',
    functionName: 'onDocumentCreatedWithAuthContext',
    channelName: 'firestore-created',
  },
  { file: 'lib/v2/providers/firestore.js', functionName: 'onDocumentUpdated', channelName: 'firestore-updated' },
  {
    file: 'lib/v2/providers/firestore.js',
    functionName: 'onDocumentUpdatedWithAuthContext',
    channelName: 'firestore-updated',
  },
  { file: 'lib/v2/providers/firestore.js', functionName: 'onDocumentDeleted', channelName: 'firestore-deleted' },
  {
    file: 'lib/v2/providers/firestore.js',
    functionName: 'onDocumentDeletedWithAuthContext',
    channelName: 'firestore-deleted',
  },
  { file: 'lib/v2/providers/firestore.js', functionName: 'onDocumentWritten', channelName: 'firestore-written' },
  {
    file: 'lib/v2/providers/firestore.js',
    functionName: 'onDocumentWrittenWithAuthContext',
    channelName: 'firestore-written',
  },
  { file: 'lib/v2/providers/scheduler.js', functionName: 'onSchedule', channelName: 'scheduler' },
  { file: 'lib/v2/providers/storage.js', functionName: 'onObjectFinalized', channelName: 'storage-finalized' },
  { file: 'lib/v2/providers/storage.js', functionName: 'onObjectArchived', channelName: 'storage-archived' },
  { file: 'lib/v2/providers/storage.js', functionName: 'onObjectDeleted', channelName: 'storage-deleted' },
  {
    file: 'lib/v2/providers/storage.js',
    functionName: 'onObjectMetadataUpdated',
    channelName: 'storage-metadata-updated',
  },
] as const;

export const firebaseConfig = [
  // v3.0.0 - v4.10.0
  ...FIRESTORE_ENTRY_FILES.flatMap(filePath =>
    FIRESTORE_OPERATIONS.map(({ functionName, channelName }) => ({
      channelName,
      module: { name: '@firebase/firestore', versionRange: '>=3.0.0 <4.10.0', filePath },
      functionQuery: { functionName, kind: 'Auto' as const },
    })),
  ),
  // v4.10.0 - v5
  ...FIRESTORE_CHUNK_FILES.flatMap(filePath =>
    FIRESTORE_OPERATIONS.map(({ functionName, channelName }) => ({
      channelName,
      module: { name: '@firebase/firestore', versionRange: '>=4.10.0 <5', filePath },
      functionQuery: { functionName, kind: 'Auto' as const },
    })),
  ),
  ...FUNCTIONS_TRIGGERS.map(({ file, functionName, channelName }) => ({
    channelName,
    module: { name: 'firebase-functions', versionRange: FUNCTIONS_VERSION_RANGE, filePath: file },
    functionQuery: { functionName, kind: 'Sync' as const },
  })),
] satisfies InstrumentationConfig[];

export const firebaseChannels = {
  FIREBASE_FIRESTORE_ADD_DOC: 'orchestrion:@firebase/firestore:add-doc',
  FIREBASE_FIRESTORE_GET_DOCS: 'orchestrion:@firebase/firestore:get-docs',
  FIREBASE_FIRESTORE_SET_DOC: 'orchestrion:@firebase/firestore:set-doc',
  FIREBASE_FIRESTORE_DELETE_DOC: 'orchestrion:@firebase/firestore:delete-doc',
  FIREBASE_FUNCTIONS_HTTP_REQUEST: 'orchestrion:firebase-functions:http-request',
  FIREBASE_FUNCTIONS_HTTP_CALL: 'orchestrion:firebase-functions:http-call',
  FIREBASE_FUNCTIONS_FIRESTORE_CREATED: 'orchestrion:firebase-functions:firestore-created',
  FIREBASE_FUNCTIONS_FIRESTORE_UPDATED: 'orchestrion:firebase-functions:firestore-updated',
  FIREBASE_FUNCTIONS_FIRESTORE_DELETED: 'orchestrion:firebase-functions:firestore-deleted',
  FIREBASE_FUNCTIONS_FIRESTORE_WRITTEN: 'orchestrion:firebase-functions:firestore-written',
  FIREBASE_FUNCTIONS_SCHEDULER: 'orchestrion:firebase-functions:scheduler',
  FIREBASE_FUNCTIONS_STORAGE_FINALIZED: 'orchestrion:firebase-functions:storage-finalized',
  FIREBASE_FUNCTIONS_STORAGE_ARCHIVED: 'orchestrion:firebase-functions:storage-archived',
  FIREBASE_FUNCTIONS_STORAGE_DELETED: 'orchestrion:firebase-functions:storage-deleted',
  FIREBASE_FUNCTIONS_STORAGE_METADATA_UPDATED: 'orchestrion:firebase-functions:storage-metadata-updated',
} as const;
