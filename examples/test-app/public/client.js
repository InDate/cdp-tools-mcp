/**
 * Client-side JavaScript for CDP-TOOLS Test Application
 */

// Challenge 1: Event Listener Setup
function setupEventListeners() {
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

  const calcButton = document.querySelector('.calc-button');
  if (calcButton) {
    calcButton.addEventListener('click', handleCalculate);
  }

  const secretButton = document.querySelector('.secret-button');
  if (secretButton) {
    secretButton.addEventListener('click', handleSecretReveal);
  }

  const stepButton = document.querySelector('.step-button');
  if (stepButton) {
    stepButton.addEventListener('click', handleStepThrough);
  }
}

// Challenge 2: User Data Fetcher
async function handleFetchUser() {
  console.log('Fetching user data...');
  const userId = document.querySelector('#user-id').value;

  try {
    const response = await fetch(`/api/user/${userId}`);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log('User data received:', data);
    document.querySelector('#result').textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    console.error('ERROR: Failed to fetch user', error);
    document.querySelector('#result').textContent = 'Error: ' + error.message;
  }
}

// Challenge 3: Data Processor
function processItems(items) {
  const result = [];

  for (let i = 0; i <= items.length; i++) {
    const item = items[i];
    if (item) {
      result.push(item.toUpperCase());
    } else {
      console.warn('WARN: Undefined item at index', i);
    }
  }

  return result;
}

async function handleProcessData() {
  console.log('Processing data...');

  const items = ['apple', 'banana', 'cherry'];

  const localProcessed = processItems(items);
  console.log('Local processed:', localProcessed);

  try {
    const response = await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });

    const data = await response.json();
    console.log('Server processed:', data);
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

// Challenge 5: Storage Manager
function handleStorage() {
  console.log('Testing localStorage...');

  const userData = {
    name: 'Test User',
    timestamp: Date.now()
  };

  localStorage.setItem('userData', JSON.stringify(userData));
  console.log('Data stored in localStorage');

  const retrieved = localStorage.getItem('user_data');
  if (retrieved) {
    console.log('Retrieved data:', JSON.parse(retrieved));
  } else {
    console.warn('WARN: Could not find user_data in localStorage');
  }

  document.querySelector('#result').textContent = 'Storage operation complete.';
}

// Challenge 4: Pricing Calculator

async function fetchPricingConfig() {
  const response = await fetch('/api/pricing');
  return response.json();
}

function applyDiscountRules(config) {
  const rules = {
    basePrice: config.basePrice,
    discountPercent: config.discountPercent,
    taxRate: config.taxRate,
    adjustedDiscount: config.discountPercent > 10 ? config.discountPercent * 100 : config.discountPercent
  };
  return rules;
}

function calculateWithRules(rules) {
  const discountAmount = rules.basePrice * (rules.adjustedDiscount / 100);
  const afterDiscount = rules.basePrice - discountAmount;
  const taxAmount = afterDiscount * (rules.taxRate / 100);
  const finalPrice = afterDiscount + taxAmount;
  return { discountAmount, afterDiscount, taxAmount, finalPrice };
}

let calculatorState = { lastResult: null, lastConfig: null };

async function handleCalculate() {
  console.log('Fetching pricing configuration from server...');

  const config = await fetchPricingConfig();
  console.log('Server config received');

  const rules = applyDiscountRules(config);
  const result = calculateWithRules(rules);

  calculatorState.lastResult = result;
  calculatorState.lastConfig = config;

  document.querySelector('#result').textContent =
    `Pricing calculation complete!\n\nFinal Price: $${result.finalPrice.toFixed(2)}\n\nExpected: ~$88.00`;
}

// Challenge 6: Secret Access
let appState = {
  debugMode: false,
  secretCode: 'HIDDEN',
  revealSecret: function() {
    if (this.debugMode) {
      return 'SECRET_CODE_42X';
    }
    return 'Access Denied - Debug mode required';
  }
};

function handleSecretReveal() {
  const result = appState.revealSecret();
  console.log('Attempting to reveal secret...');
  document.querySelector('#result').textContent = result;
}

// Challenge 8: State Machine Pipeline

const sharedState = {
  value: 0,
  multiplier: 1,
  history: []
};

function resetState() {
  sharedState.value = 0;
  sharedState.multiplier = 1;
  sharedState.history = [];
}

function initializeState(input) {
  sharedState.value = input;
  sharedState.multiplier = 2;
  sharedState.history.push('init: ' + input);
  return processStep1(sharedState);
}

function processStep1(state) {
  state.value = state.value + 10;
  state.history.push('step1: +10 = ' + state.value);
  return processStep2(state);
}

function processStep2(state) {
  state.value = state.value * state.multiplier;
  state.multiplier = 0;
  state.history.push('step2: *2 = ' + state.value);
  return processStep3(state);
}

function processStep3(state) {
  state.value = state.value * state.multiplier;
  state.history.push('step3: *multiplier = ' + state.value);
  return state.value;
}

function runStateMachine(input) {
  resetState();
  return initializeState(input);
}

function handleStepThrough() {
  const input = 5;
  console.log('Running state machine with input:', input);
  const result = runStateMachine(input);

  document.querySelector('#result').textContent =
    `State Machine Result:\n\nInput: ${input}\nOutput: ${result}\n\nExpected: 60\nActual: ${result}`;
}

// Challenge 7: Vault Password Generator
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
  console.log('Testing cdp-tools Debugger');
  console.warn('This is a warning message');
  console.error('This is an error message for testing');
});
