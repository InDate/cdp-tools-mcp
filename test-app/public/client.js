/**
 * Client-side JavaScript with intentional bugs
 * These bugs will be debugged using Chrome DevTools Protocol
 */

// Challenge 1: DOM Manipulation Bug
function setupEventListeners() {
  // FIXED: Corrected typo from "buttom" to "button"
  const fetchButton = document.querySelector('.fetch-button');

  if (fetchButton) {
    fetchButton.addEventListener('click', handleFetchUser);
  } else {
    console.error('ERROR: Fetch button not found!');
  }

  const processButton = document.querySelector('.process-button');
  if (processButton) {
    processButton.addEventListener('click', handleProcessData);
  }

  const slowButton = document.querySelector('.slow-button');
  if (slowButton) {
    slowButton.addEventListener('click', handleSlowRequest);
  }

  const storageButton = document.querySelector('.storage-button');
  if (storageButton) {
    storageButton.addEventListener('click', handleStorage);
  }

  const vaultButton = document.querySelector('.vault-button');
  if (vaultButton) {
    vaultButton.addEventListener('click', handleVault);
  }
}

// Challenge 2: Network Request Bug
async function handleFetchUser() {
  console.log('Fetching user data...');
  const userId = document.querySelector('#user-id').value;

  try {
    const response = await fetch(`/api/user/${userId}`);
    const data = await response.json();

    // BUG: Not checking response.ok, so treats error as success
    console.log('User data received:', data);
    document.querySelector('#result').textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    console.error('ERROR: Failed to fetch user', error);
    document.querySelector('#result').textContent = 'Error: ' + error.message;
  }
}

// Challenge 3 & 4: Console Error + Variable Inspection
async function handleProcessData() {
  console.log('Processing data...');

  const items = ['apple', 'banana', 'cherry'];

  try {
    const response = await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });

    const data = await response.json();
    console.log('Processed data:', data);
    document.querySelector('#result').textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    console.error('ERROR: Failed to process data', error);
  }
}

// Challenge 6: Performance Issue
async function handleSlowRequest() {
  console.log('Starting slow request...');
  const startTime = Date.now();

  try {
    const response = await fetch('/api/slow');
    const data = await response.json();

    const duration = Date.now() - startTime;
    console.log(`Request completed in ${duration}ms`);

    document.querySelector('#result').textContent =
      `${data.message} (took ${duration}ms)`;
  } catch (error) {
    console.error('ERROR: Slow request failed', error);
  }
}

// Challenge 5: localStorage Bug
function handleStorage() {
  console.log('Testing localStorage...');

  // BUG: Storing wrong key name
  const userData = {
    name: 'Test User',
    timestamp: Date.now()
  };

  // BUG: Storing as "usr_data" instead of "user_data"
  localStorage.setItem('usr_data', JSON.stringify(userData));
  console.log('Data stored in localStorage');

  // Trying to retrieve with correct key (will fail)
  const retrieved = localStorage.getItem('user_data');
  if (retrieved) {
    console.log('Retrieved data:', JSON.parse(retrieved));
  } else {
    console.warn('WARN: Could not find user_data in localStorage');
  }

  document.querySelector('#result').textContent =
    'Check localStorage! Look for the bug.';
}

// Challenge 4: Async race condition (client-side version)
let requestCounter = 0;

async function triggerRaceCondition() {
  const id = ++requestCounter;
  console.log(`Starting request ${id}`);

  const response = await fetch('/api/async-data');
  const data = await response.json();

  console.log(`Request ${id} completed with data:`, data);
  return data;
}

// Challenge 7: Secret Vault Password (Logpoints Required)
// LOGPOINT CHALLENGE: Set logpoints in constructVaultPassword() to observe password construction
function constructVaultPassword() {
  const securityTokens = ['Secret', 'Passphrase', 'Alpha', 'Bravo', 'Charlie', 'Delta'];
  let password = '';


  for (let i = 0; i < securityTokens.length; i++) {
    const token = securityTokens[i];
    const char = token.charAt(0); // Get first character of each token
    password += char;
  }

  return password;
}

// Adds access level modifier to password
function getAccessModifier(level) {
  let modifier = '';

  if (level >= 1) {
    modifier += '_L';
  }

  if (level >= 2) {
    modifier += String(level);
  }

  if (level >= 5) {
    modifier += '_ADMIN';
  }

  return modifier;
}

async function handleVault() {
  console.log('Attempting to unlock vault...');

  const userId = document.querySelector('#vault-user-id').value || 1;
  const accessLevel = parseInt(document.querySelector('#vault-access-level').value || 1);

  console.log(`User ${userId} attempting to unlock vault with level ${accessLevel}`);

  const basePassword = constructVaultPassword();
  const modifier = getAccessModifier(accessLevel);

  const finalPassword = basePassword + modifier;

  console.log('Vault password generated successfully');

  try {
    const response = await fetch('/api/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, accessLevel, password: finalPassword })
    });

    const data = await response.json();
    console.log('Vault response:', data);

    if (data.success) {
      document.querySelector('#result').textContent =
        `✅ ${data.message}\n\nPassword: ${data.password}\n\n${data.hint}`;
    } else {
      document.querySelector('#result').textContent =
        `❌ ${data.message}`;
    }
  } catch (error) {
    console.error('ERROR: Failed to unlock vault', error);
    document.querySelector('#result').textContent = 'Error: ' + error.message;
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  console.log('Page loaded, initializing...');
  setupEventListeners();

  // Trigger some initial console messages
  console.log('Testing LLM-CDP Debugger');
  console.warn('This is a warning message');
  console.error('This is an error message for testing');
});
