import { passwordHash } from './auth.js';
const password = process.argv[2];
if (!password || password.length < 16) throw new Error('Provide a password of at least 16 characters.');
console.log(await passwordHash(password));
