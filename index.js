import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import { createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { createRequestListener } from '@mjackson/node-fetch-server';
import * as decentauth from 'decent-auth';
import Database from 'libsql';
import { computeHash } from './utils.js';

const behindProxy = true;
//const behindProxy = false;

const MAX_CONTENT_LENGTH = 1024;

const dbPath = 'gemdrive.sqlite';
const db = new Database(dbPath);
await db.exec(
`CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  time TEXT NOT NULL,
  path TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  mod_time TEXT NOT NULL,
  owner TEXT NOT NULL,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  content TEXT
)`
);

const clients = {};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

const authPrefix = '/auth';
const fsRoot = 'files';
await fs.mkdir(fsRoot, { recursive: true });

const authServer = new decentauth.Server({
  // TODO: we should probably be passing this a libsql instance
  kvStore: new decentauth.SqliteKvStore({
    path: dbPath,
  }),
  config: {
    behind_proxy: behindProxy,
    path_prefix: authPrefix,
    login_methods: [
      {
        type: decentauth.LOGIN_METHOD_OIDC,
        name: "LastLogin",
        uri: "https://lastlogin.net",
      },
      {
        type: decentauth.LOGIN_METHOD_ATPROTO,
      }
    ],
  },
});

async function handler(req) {
  const url = new URL(req.url);
  const params = new URLSearchParams(url.search);

  console.log("here", req);

  const host = behindProxy ? req.headers.get('X-Forwarded-Host') : url.host;
  const proto = behindProxy ? req.headers.get('X-Forwarded-Proto') + ':' : url.protocol;

  if (url.pathname.startsWith(authPrefix) || url.pathname === '/.well-known/oauth-authorization-server') {
    return authServer.handle(req);
  }

  const start = performance.now()
  const session = await authServer.getSession(req);
  console.log("sesh", session);
  console.log("dur", url.pathname, performance.now() - start);

  const headers = {
    'Access-Control-Allow-Origin': '*',
  };

  if (!session) {
    if (url.pathname === '/') {
      return Response.redirect(`${proto}//${host}${authPrefix}`);
    }

    // Return the oauth metadata directly rather than requiring the client to
    // make another request
    const authServerReq = new Request(`${url.origin}/.well-known/oauth-authorization-server`);

    const metaRes = await authServer.handle(authServerReq);

    const res = new Response(metaRes.body, {
      status: 401,
      headers: metaRes.headers,
    });

    return res;
  }

  if (url.pathname.startsWith('/gemdrive')) {
    return handleGemDrive(req);
  }

  const fsPath = path.join(fsRoot, url.pathname);

  if (req.method === 'GET') {
    try {
      const statData = await fs.stat(fsPath);
      const data = await fs.readFile(fsPath);

      const hashInput = statData.size + new Date(statData.mtimeMs).toISOString();
      const etag = await computeHash(hashInput);
      headers['ETag'] = etag.slice(0, 16);
      return new Response(data, {
        headers,
      });
    }
    catch (e) {
      return new Response("Not found", {
        status: 404,
        headers,
      });
    }
  }
  else if (req.method === 'POST') {

    if (params.get('method') === 'delete') {
      await fs.rm(fsPath);

      const results = await db.prepare(
        `INSERT INTO events(time,path,type,size,mod_time,owner,offset,length,content) VALUES(?,?,?,?,?,?,?,?,?)`
      ).run([new Date().toISOString(), url.pathname,'delete',0,'','',0,0,null]);

      emit(clients, JSON.stringify({
        type: 'delete',
        path: url.pathname,
      }));
    }
    else {

      await fs.mkdir(path.dirname(fsPath), { recursive: true });

      const [ body1, body2 ] = req.body.tee();

      const contentPromise = readContent(body2);

      const promises = [ contentPromise, pipeStreamToFile(body1, fsPath) ];
      const [ { length, content }, _ ] = await Promise.all(promises);

      const statData = await fs.stat(fsPath);

      const data = {
        path: url.pathname,
        type: 'write',
        size: statData.size,
        modTime: new Date(statData.mtimeMs).toISOString(),
        owner: session.id,
        offset: 0,
        length,
      }; 

      if (content) {
        // TODO: can't currently handle binary data
        data.content = decoder.decode(content);
      }

      const results = await db.prepare(
        `INSERT INTO events(time,path,type,size,mod_time,owner,offset,length,content) VALUES(?,?,?,?,?,?,?,?,?)`
      ).run([new Date().toISOString(),data.path,data.type,data.size,data.modTime,data.owner,data.offset,data.length,data.content]);

      emit(clients, JSON.stringify(data));
    }

    return new Response(null, {
      headers,
    });
  }

  return new Response("Hi there", {
    headers,
  });

  //return Response.redirect(`${url.origin}${authPrefix}`, 303);
}

async function readContent(body) {
  return new Promise(async (resolve, reject) => {
    const partialContent = new Uint8Array(MAX_CONTENT_LENGTH);
    let offset = 0;

    for await (const chunk of body) {
      if ((offset + chunk.length) > MAX_CONTENT_LENGTH) {
        // too big. need to keep reading but skip remaining chunks
        offset += chunk.length;
        continue;
      }

      partialContent.set(chunk, offset);
      offset += chunk.length;
    }

    if (offset <= MAX_CONTENT_LENGTH) {
      resolve({
        length: offset,
        content: partialContent.slice(0, offset),
      });
    }
    else {
      resolve({
        length: offset,
      });
    }
  });
}

async function handleGemDrive(req) {

  const url = new URL(req.url);

  if (url.pathname === '/gemdrive/events/') {
     return handleEvents(req);
  }

  const parts = url.pathname.split('/');
  const fsDir = path.join(fsRoot, parts.slice(2, -1).join('/'));

  const files = await fs.readdir(fsDir, {
    withFileTypes: true,
  });

  const dir = Object.fromEntries(files.map((f) => {
    const filePath = path.join(f.parentPath, f.name);
    const statData = nodeFs.statSync(filePath);
    const suffix = f.isDirectory() ? '/' : '';
    return [
      f.name + suffix,
      {
        size: statData.size,
        modTime: new Date(statData.mtimeMs).toISOString(),
      }
    ];
  }));

  return new Response(JSON.stringify(dir), {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    },
  });
}

async function handleEvents(req) {

  const url = new URL(req.url);
  const params = new URLSearchParams(url.search);

  const clientId = crypto.randomUUID();
  // Using two separate streams here because we need to return a stream
  // immediately, but there might also be new events before the async section
  // below executes and we don't want those to get lost
  const queuingStrat = new CountQueuingStrategy({
    highWaterMark: 128,
  });
  const newEvents = new TransformStream({}, queuingStrat);
  const responseStream = new TransformStream();

  clients[clientId] = newEvents.writable.getWriter();

  req.signal.addEventListener('abort', () => {
    delete clients[clientId];
  });

  (async () => {
    const writer = responseStream.writable.getWriter();
    await writer.ready;
    await writer.write(JSON.stringify({
      debug: "init",
    }) + '\n');

    const sinceParam = params.get('since');

    if (sinceParam) {
      const stmt = db.prepare(`
        SELECT * FROM events WHERE time >= ?;
      `);

      for (const evt of stmt.iterate([sinceParam])) {
        await writer.write(JSON.stringify(evt) + '\n');
      }
    }

    writer.releaseLock();
    
    newEvents.readable.pipeTo(responseStream.writable);
  })();

  console.log(clients); 

  return new Response(responseStream.readable, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/x-ndjson',
    },
  });
}

async function emit(writers, inMsg) {
  console.log("emit", inMsg);
  for (const id in writers) {
    const msg = inMsg + '\n';
    const writer = writers[id];
    await writer.ready;
    writer.write(msg);
  }
}

async function pipeStreamToFile(readableStream, filePath) {
  // Open a writable file stream
  const writableStream = createWriteStream(filePath, { flags: 'w' });

  const reader = readableStream.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      // Decode the chunk and write to the file
      const chunk = decoder.decode(value);
      writableStream.write(chunk);
    }
  } catch (err) {
    console.error("Error while reading or writing stream:", err);
  } finally {
    // Ensure the writable stream is closed
    writableStream.end();
    reader.releaseLock();
  }

  await new Promise((resolve, reject) => {
    writableStream.on('finish', resolve);
  });
}

http.createServer(createRequestListener(handler)).listen(5757);
