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

// ============================================
// TEST SCENARIOS FOR getVariables FALLBACKS
// ============================================

// Test scenario for names_only fallback (~100 variables)
function testManyVariables() {
  // Create ~100 local variables to trigger names_only fallback
  const var01 = "value01", var02 = "value02", var03 = "value03", var04 = "value04", var05 = "value05";
  const var06 = "value06", var07 = "value07", var08 = "value08", var09 = "value09", var10 = "value10";
  const var11 = "value11", var12 = "value12", var13 = "value13", var14 = "value14", var15 = "value15";
  const var16 = "value16", var17 = "value17", var18 = "value18", var19 = "value19", var20 = "value20";
  const var21 = "value21", var22 = "value22", var23 = "value23", var24 = "value24", var25 = "value25";
  const var26 = "value26", var27 = "value27", var28 = "value28", var29 = "value29", var30 = "value30";
  const var31 = "value31", var32 = "value32", var33 = "value33", var34 = "value34", var35 = "value35";
  const var36 = "value36", var37 = "value37", var38 = "value38", var39 = "value39", var40 = "value40";
  const var41 = "value41", var42 = "value42", var43 = "value43", var44 = "value44", var45 = "value45";
  const var46 = "value46", var47 = "value47", var48 = "value48", var49 = "value49", var50 = "value50";
  const var51 = "value51", var52 = "value52", var53 = "value53", var54 = "value54", var55 = "value55";
  const var56 = "value56", var57 = "value57", var58 = "value58", var59 = "value59", var60 = "value60";
  const var61 = "value61", var62 = "value62", var63 = "value63", var64 = "value64", var65 = "value65";
  const var66 = "value66", var67 = "value67", var68 = "value68", var69 = "value69", var70 = "value70";
  const var71 = "value71", var72 = "value72", var73 = "value73", var74 = "value74", var75 = "value75";
  const var76 = "value76", var77 = "value77", var78 = "value78", var79 = "value79", var80 = "value80";
  const obj1 = { a: 1 }, obj2 = { b: 2 }, obj3 = { c: 3 }, obj4 = { d: 4 }, obj5 = { e: 5 };
  const obj6 = { f: 6 }, obj7 = { g: 7 }, obj8 = { h: 8 }, obj9 = { i: 9 }, obj10 = { j: 10 };

  debugger; // BREAKPOINT: ~90 variables - should trigger names_only

  console.log("Many variables test", var01, var80, obj1, obj10);
}

// Test scenario for depth_reduced fallback (deep nested objects)
function testDeepObjects() {
  // Create objects that are large when expanded but small at depth 0
  const deepObj1 = {
    level1: {
      level2a: { level3a: { value: "deep1", data: [1,2,3,4,5] }, level3b: { value: "deep2", data: [6,7,8,9,10] } },
      level2b: { level3c: { value: "deep3", data: [11,12,13,14,15] }, level3d: { value: "deep4", data: [16,17,18,19,20] } }
    }
  };
  const deepObj2 = {
    level1: {
      level2a: { level3a: { value: "deep5", data: [21,22,23,24,25] }, level3b: { value: "deep6", data: [26,27,28,29,30] } },
      level2b: { level3c: { value: "deep7", data: [31,32,33,34,35] }, level3d: { value: "deep8", data: [36,37,38,39,40] } }
    }
  };
  const deepObj3 = {
    level1: {
      level2a: { level3a: { value: "deep9", data: [41,42,43,44,45] }, level3b: { value: "deep10", data: [46,47,48,49,50] } },
      level2b: { level3c: { value: "deep11", data: [51,52,53,54,55] }, level3d: { value: "deep12", data: [56,57,58,59,60] } }
    }
  };
  const deepObj4 = {
    config: { settings: { options: { enabled: true, values: [1,2,3,4,5,6,7,8,9,10] } } },
    metadata: { info: { details: { name: "test", tags: ["a","b","c","d","e","f","g","h","i","j"] } } }
  };
  const deepObj5 = {
    users: { admin: { permissions: { read: true, write: true, delete: true, admin: true } } },
    roles: { superuser: { capabilities: { manage: true, configure: true, deploy: true } } }
  };

  debugger; // BREAKPOINT: 5 deep objects - may trigger depth_reduced

  console.log("Deep objects test", deepObj1, deepObj2, deepObj3, deepObj4, deepObj5);
}

// Expose test functions globally
window.testManyVariables = testManyVariables;
window.testDeepObjects = testDeepObjects;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  console.log('Page loaded, initializing...');
  setupEventListeners();

  // Trigger some initial console messages
  console.log('Testing cdp-tools Debugger');
  console.warn('This is a warning message');
  console.error('This is an error message for testing');

  // Log test functions availability
  console.log('Test functions available: testManyVariables(), testDeepObjects()');
});
