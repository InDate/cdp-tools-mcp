/**
 * Client-side JavaScript with intentional bugs
 * These bugs will be debugged using Chrome DevTools Protocol
 */

// Challenge 5: DOM Manipulation Bug
function setupEventListeners() {
  // BUG: Typo in selector - "buttom" instead of "button"
  const fetchButton = document.querySelector('.fetch-buttom');

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
}

// Challenge 1: Network Request Bug
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

// Challenge 2 & 3: Console Error + Variable Inspection
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

// Challenge 8: Performance Issue
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

// Challenge 7: localStorage Bug
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

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  console.log('Page loaded, initializing...');
  setupEventListeners();

  // Trigger some initial console messages
  console.log('Testing LLM-CDP Debugger');
  console.warn('This is a warning message');
  console.error('This is an error message for testing');
});
