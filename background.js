// ChatGPT Message Queue - Background Service Worker
// Handles badge updates and message passing

// Update badge with queue count
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'updateBadge') {
    const count = message.count;

    if (count > 0) {
      chrome.action.setBadgeText({ text: count.toString() });
      chrome.action.setBadgeBackgroundColor({ color: '#10a37f' }); // ChatGPT green
    } else {
      chrome.action.setBadgeText({ text: '' });
    }

    sendResponse({ success: true });
  }
  return true;
});

// Clear badge when extension is installed/updated
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: '' });
  console.log('[ChatGPT Queue] Extension installed/updated');
});
