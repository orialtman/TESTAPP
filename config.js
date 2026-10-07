/* Where's My Car? — cloud sync configuration.
 *
 * Device-only mode (default): leave FIREBASE_CONFIG = null.
 * Accounts and parking history live in this browser's localStorage.
 *
 * Cloud mode: paste your Firebase web-app config below. Accounts then work
 * from any device and parking history syncs live between them.
 * Get the config at: Firebase console → Project settings → Your apps → Web.
 */
window.FIREBASE_CONFIG = null;

/* Example — replace with your real values and delete "null" above:
window.FIREBASE_CONFIG = {
  apiKey: "AIza....",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc123"
};
*/
