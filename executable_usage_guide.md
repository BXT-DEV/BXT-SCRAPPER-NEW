# 📦 BXT-SCRAPPER Executable Guide

This guide explains how to run the `bxt-scrapper.exe` on Windows.

## 🛠 Prerequisites

1.  **Playwright Browsers**: The scraper requires Chromium. If you don't have it installed via Playwright yet, run this in your terminal:
    ```bash
    npx playwright install chromium
    ```
    *(If you don't have Node.js/npm installed on that machine, you will need to install it once to get the browsers, or copy the `%USERPROFILE%\AppData\Local\ms-playwright` folder from another machine).*

## 🚀 How to Run

1.  **Extract the files**: Make sure the `.exe` is in a folder where you have write permissions.
2.  **Configuration**:
    - Create a `.env` file in the same folder as the `.exe`.
    - You can copy the `.env.example` file and rename it to `.env`.
    - Fill in your `GEMINI_API_KEY` and other settings.
3.  **Input Data**:
    - Create an `input` folder.
    - Place your `products.csv` inside it.
4.  **Run the Scrapper**:
    - Double-click `bxt-scrapper.exe` or run it via Command Prompt/PowerShell:
      ```powershell
      .\bxt-scrapper.exe
      ```

## ⚙️ Configuration UI (Optional)
If you want to use the web-based configuration tool:
1.  Run the config tool (if packaged separately, otherwise use Node.js):
    ```bash
    node dist/config-ui.js
    ```
    *(Note: Future versions will include a `bxt-config.exe`)*

## 📂 Folders Created
When the scrapper runs, it will automatically create:
- `logs/`: For execution and error logs.
- `output/`: Where your results (CSV) will be saved.
