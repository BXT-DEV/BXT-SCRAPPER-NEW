import readline from "readline";
import { 
  hasCredentialsFile, 
  loadCredentials, 
  saveCredentials, 
  promptPassword 
} from "../utils/credentials-manager.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const askQuestion = (query: string): Promise<string> => {
  return new Promise((resolve) => rl.question(query, resolve));
};

async function main() {
  console.log("=========================================");
  console.log("🔐 Credentials Manager CLI");
  console.log("=========================================");

  let password = "";
  let creds: Record<string, string> = {};

  if (hasCredentialsFile()) {
    console.log("Detected existing credentials file.");
    let authenticated = false;
    while (!authenticated) {
      password = await promptPassword("Enter your decryption password: ");
      try {
        creds = loadCredentials(password);
        authenticated = true;
        console.log("🔑 Decrypted credentials successfully.\n");
      } catch (err) {
        console.log("❌ Incorrect password. Please try again.\n");
      }
    }
  } else {
    console.log("No credentials file found. Let's initialize a new one.");
    let match = false;
    while (!match) {
      password = await promptPassword("Set a master password: ");
      const confirm = await promptPassword("Confirm master password: ");
      if (password === confirm) {
        match = true;
      } else {
        console.log("❌ Passwords do not match. Try again.\n");
      }
    }
    creds = {};
    saveCredentials(creds, password);
    console.log("✨ Initialized empty credentials file successfully.\n");
  }

  while (true) {
    console.log("--- Menu ---");
    console.log("1. List credential keys");
    console.log("2. Set/Update a key");
    console.log("3. Delete a key");
    console.log("4. Exit");
    
    const choice = (await askQuestion("Choose an option (1-4): ")).trim();
    console.log("");

    if (choice === "1") {
      const keys = Object.keys(creds);
      if (keys.length === 0) {
        console.log("No credentials stored yet.");
      } else {
        console.log("Stored credentials:");
        for (const key of keys) {
          const val = creds[key];
          const masked = val.length > 10 
            ? `${val.substring(0, 6)}...${val.substring(val.length - 4)}` 
            : "***";
          console.log(`  - ${key}: ${masked}`);
        }
      }
      console.log("");
    } else if (choice === "2") {
      const key = (await askQuestion("Enter key name (e.g. GEMINI_API_KEY): ")).trim();
      if (!key) {
        console.log("Invalid key name.");
        continue;
      }
      const val = (await askQuestion(`Enter value for ${key}: `)).trim();
      if (!val) {
        console.log("Value cannot be empty.");
        continue;
      }
      creds[key] = val;
      saveCredentials(creds, password);
      console.log(`✅ Saved ${key}.\n`);
    } else if (choice === "3") {
      const key = (await askQuestion("Enter key name to delete: ")).trim();
      if (creds[key] !== undefined) {
        delete creds[key];
        saveCredentials(creds, password);
        console.log(`✅ Deleted ${key}.\n`);
      } else {
        console.log(`❌ Key ${key} not found.\n`);
      }
    } else if (choice === "4" || choice === "") {
      console.log("Goodbye!");
      rl.close();
      process.exit(0);
    } else {
      console.log("Invalid option.");
    }
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  rl.close();
  process.exit(1);
});
