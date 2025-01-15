import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import { createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { createRequestListener } from '@mjackson/node-fetch-server';
import * as decentauth from 'decent-auth';

const MAX_CONTENT_LENGTH = 1024;

const clients = {};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

const authPrefix = '/auth';
const fsRoot = 'files';
await fs.mkdir(fsRoot, { recursive: true });

const authServer = new decentauth.Server({
  config: {
    path_prefix: authPrefix,
    login_methods: [
      {
        type: decentauth.LOGIN_METHOD_OIDC,
        name: "LastLogin",
        uri: "https://lastlogin.net",
      }
    ],
  },
});

async function handler(req) {
  const url = new URL(req.url);
  const params = new URLSearchParams(url.search);

  if (url.pathname.startsWith(authPrefix)) {
    return authServer.handle(req);
  }

  const start = performance.now()
  const session = await authServer.getSession(req);
  //console.log(session);
  console.log("dur", url.pathname, performance.now() - start);

  const headers = {
    'Access-Control-Allow-Origin': '*',
  };

  if (!session) {
    if (url.pathname === '/') {
      return Response.redirect(`https://example.com/${authPrefix}`);
    }

    return new Response("No auth", {
      headers,
      status: 401,
    });
  }

  if (url.pathname.startsWith('/gemdrive')) {
    return handleGemDrive(req);
  }

  const fsPath = path.join(fsRoot, url.pathname);

  if (req.method === 'GET') {
    try {
      const data = await fs.readFile(fsPath);
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
        owner: session.id,
        type: 'write',
        offset: 0,
        length,
        path: url.pathname,
        size: statData.size,
        modTime: new Date(statData.mtimeMs).toISOString(),
      };

      if (content) {
        // TODO: can't currently handle binary data
        data.content = decoder.decode(content);
      }

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

async function handleEvents(req) {
  const clientId = crypto.randomUUID();
  const stream = new TransformStream();

  const writer = stream.writable.getWriter();
  clients[clientId] = writer;

  (async () => {
    await writer.ready;
    writer.write(JSON.stringify({
      debug: "init",
    }) + '\n');
  })();

  console.log(clients); 

  return new Response(stream.readable, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      //'Content-Type': 'application/json',
      //'Content-Type': 'text/plain',
    },
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
