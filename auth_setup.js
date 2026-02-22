const {google} = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SCOPES = ['https://www.googleapis.com/auth/photoslibrary.readonly'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

async function main() {
  try {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const {client_secret, client_id, redirect_uris} = credentials.installed || credentials.web;
    
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });
    
    console.log('\n===========================================');
    console.log('Authorize this app by visiting this url:');
    console.log(authUrl);
    console.log('===========================================\n');
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    rl.question('Enter the code from that page here: ', async (code) => {
      rl.close();
      try {
        const {tokens} = await oauth2Client.getToken(code);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        console.log('\n✓ Token stored successfully!');
        console.log('You can now start MagicMirror.');
      } catch (err) {
        console.error('Error retrieving access token:', err);
      }
    });
  } catch (error) {
    console.error('Error reading credentials file:', error);
    console.log('\nPlease make sure credentials.json exists in the module directory.');
  }
}

main();
