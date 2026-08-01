import { createHash } from 'crypto';
const email = 'hlancaric88@gmail.com'.trim().toLowerCase();
const nodeHash = createHash('sha256').update(email).digest('hex');

async function subtleHash(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

console.log('Node hash:', nodeHash);
subtleHash(email).then(res => console.log('Subtle hash:', res));
