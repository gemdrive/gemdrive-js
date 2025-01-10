import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { createRequestListener } from '@mjackson/node-fetch-server';
import * as decentauth from 'decent-auth';

const clients = {};

const encoder = new TextEncoder();

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

  //console.log("Session:", await authServer.getSession(req));

  if (params.get('events') === 'true') {
     return handleEvents(req);
  }

  const fsPath = path.join(fsRoot, url.pathname);

  const headers = {
    'Access-Control-Allow-Origin': '*',
  };

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
    await fs.mkdir(path.dirname(fsPath), { recursive: true });
    await pipeStreamToFile(req.body, fsPath);
    emit(clients, JSON.stringify({
      path: url.pathname,
    }));
    return new Response(null, {
      headers,
    });
  }

  return new Response("Hi there", {
    headers,
  });

  //return Response.redirect(`${url.origin}${authPrefix}`, 303);
}

async function handleEvents(req) {
  const clientId = crypto.randomUUID();
  const stream = new TransformStream();

  const writer = stream.writable.getWriter();
  clients[clientId] = writer;

  console.log(clients); 

  return new Response(stream.readable, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      //'Content-Type': 'application/json',
      //'Content-Type': 'text/plain',
    },
  });
}

async function emit(writers, inMsg) {
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
}

http.createServer(createRequestListener(handler)).listen(5757);
