const payloads = [
  "EFIABE1RVFQEwgA8ABRzdWItTFAwQVJqdmpyb016ZkF1dwAJQUQxOTU2Nzg1ACU3TFFJMkxjdDhIcUZKQ1hhV1FwOVBhS0tNdTg1dk1Ld3xKVEpo",
  "EFIABE1RVFQEwgA8ABRzdWItbGVRZGhVZWFJZkxzQk5RSAAJQUQxOTU2Nzg1ACU3TFFJMkxjdDhIcUZKQ1hhV1FwOVBhS0tNdTg1dk1Ld3xVQWti"
];

payloads.forEach((p, i) => {
  const buf = Buffer.from(p, 'base64');
  console.log(`\n--- Payload ${i} ---`);
  console.log('Hex:', buf.toString('hex'));
  console.log('Connect Flags:', buf[1].toString(2)); 
  console.log('String:', buf.toString('utf8').replace(/[^a-zA-Z0-9\-\_\.\%\|]/g, '.'));
});
