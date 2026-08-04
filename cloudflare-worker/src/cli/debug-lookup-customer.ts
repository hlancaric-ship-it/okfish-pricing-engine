// One-off: look up a customer's discount tier via the Worker's own public
// discount endpoint, using the real CF_WORKER_URL secret (avoids guessing domains).
import * as crypto from 'crypto';

async function main() {
    const email = process.env.EMAIL;
    const workerUrl = process.env.CF_WORKER_URL;
    if (!email) throw new Error('EMAIL not set');
    if (!workerUrl) throw new Error('CF_WORKER_URL not set');

    const hash = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
    console.log('hash:', hash);
    const url = `${workerUrl}/v1/discount/${hash}`;
    console.log('url:', url);
    const res = await fetch(url);
    console.log('status:', res.status);
    console.log('body:', await res.text());
}
main().catch(e => { console.error(e); process.exit(1); });
