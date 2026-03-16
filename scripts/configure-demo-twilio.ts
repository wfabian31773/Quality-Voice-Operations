import 'dotenv/config';

const ALL_DEMO_NUMBERS = [
  '+18186193692',
  '+15625611218',
  '+17604376683',
  '+16266353027',
  '+18189388394',
  '+16266572702',
  '+17602923017',
  '+17147092449',
  '+19096374843',
];

async function main() {
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (!devDomain) {
    console.error('ERROR: REPLIT_DEV_DOMAIN is not set');
    process.exit(1);
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    console.error('ERROR: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
    process.exit(1);
  }

  const twilio = require('twilio');
  const client = twilio(accountSid, authToken);

  const voiceUrl = `https://${devDomain}/twilio/voice`;
  const statusUrl = `https://${devDomain}/twilio/status`;
  const smsUrl = `https://${devDomain}/twilio/sms`;

  console.log(`=== Configuring ${ALL_DEMO_NUMBERS.length} Twilio numbers ===`);
  console.log(`Voice URL:  ${voiceUrl}`);
  console.log(`Status URL: ${statusUrl}`);
  console.log(`SMS URL:    ${smsUrl}`);
  console.log();

  let success = 0;
  let failed = 0;

  for (const number of ALL_DEMO_NUMBERS) {
    try {
      const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: number });
      if (numbers.length === 0) {
        console.error(`  SKIP ${number} — not found in Twilio account`);
        failed++;
        continue;
      }

      const sid = numbers[0].sid;
      await client.incomingPhoneNumbers(sid).update({
        voiceUrl,
        voiceMethod: 'POST',
        statusCallback: statusUrl,
        statusCallbackMethod: 'POST',
        smsUrl,
        smsMethod: 'POST',
      });

      console.log(`  OK   ${number} (${sid})`);
      success++;
    } catch (err) {
      console.error(`  FAIL ${number} — ${String(err)}`);
      failed++;
    }
  }

  console.log(`\n=== Done: ${success} configured, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
