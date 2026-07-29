#!/usr/bin/env node
// Route diagnostics for OpenAI: did the proxy actually apply in this environment?
//   npm run diag

const mask = (v) => (v ? v.replace(/\/\/[^@]*@/, '//***@') : '(unset)');

console.log('node           ', process.version, process.execPath);
console.log('execArgv       ', JSON.stringify(process.execArgv));
console.log('--use-env-proxy', process.execArgv.includes('--use-env-proxy') ? 'YES' : 'NO');
console.log('NODE_USE_ENV_PROXY', process.env.NODE_USE_ENV_PROXY || '(unset)');
console.log('HTTPS_PROXY    ', mask(process.env.HTTPS_PROXY));
console.log('HTTP_PROXY     ', mask(process.env.HTTP_PROXY));
console.log('NO_PROXY       ', process.env.NO_PROXY || '(unset)');
console.log('NODE_EXTRA_CA_CERTS', process.env.NODE_EXTRA_CA_CERTS || '(unset)');
console.log('');

try {
    const res = await fetch('https://auth.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'probe', code: 'probe' }).toString(),
    });
    const text = (await res.text()).slice(0, 220).replace(/\s+/g, ' ');
    console.log(`token endpoint: HTTP ${res.status}`);
    console.log(`  ${text}\n`);
    if (/unsupported_country/.test(text)) {
        console.log('VERDICT: the request went DIRECT — the proxy did not apply.');
        console.log('  Check that HTTPS_PROXY is listed above and that "--use-env-proxy: YES".');
        process.exitCode = 2;
    } else {
        console.log('VERDICT: route works — sign-in should succeed.');
    }
} catch (e) {
    console.log('REQUEST ERROR:', e.message);
    process.exitCode = 3;
}
