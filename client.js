import { readStreamLines } from './utils.js';

const rootUri = 'https://gds.tn7.org';

const res = await fetch(`${rootUri}?events=true`);

if (!res.ok) {
  console.error(res);
}

for await (const msgText of readStreamLines(res.body)) {
  const msg = JSON.parse(msgText);
  console.log(msg);

  const res = await fetch(`${rootUri}${msg.path}`);
  console.log(await res.text());
}
