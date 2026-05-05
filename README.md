# Meteora Bundler for Solana Token Launch (DAMM v2 + Alpha Vault FCFS)

Meteora bundler to automate a Solana token launch with:
- token mint creation (SPL or Token-2022)
- Meteora DAMM v2 pool creation
- Meteora Alpha Vault FCFS creation

This repository is designed for teams searching for a **Meteora launch bundler**, **Meteora Alpha Vault script**, **DAMM v2 launch bot**, or **Solana stealth bundler workflow**.

---

## Keywords (Search Intent)

Meteora bundler, Meteora Alpha Vault, Meteora DAMM v2, Solana token launch, Solana launch bot, FCFS vault, stealth bundler, bundled launch wallets, WSOL launch, USDC launch, Token-2022 mint, SPL mint, Meteora pool creation.

---

## What This Meteora Bundler Does

This project automates the full launch path:

1. Mint a new token with metadata and image upload (Pinata/IPFS).
2. Create a Meteora DAMM v2 pool with launch liquidity.
3. Create an Alpha Vault FCFS linked to that pool.

The flow is useful when you want controlled early participation at one price using Alpha Vault mechanics instead of public sniping-style entry.

---

## Repository Structure

- `src/token_mint.ts` - Create SPL or Token-2022 mint, upload metadata, mint initial supply.
- `src/damm-v2-launch.ts` - Create Meteora DAMM v2 pool and save pool output.
- `src/alpha-vault-fcfs.ts` - Create Meteora Alpha Vault FCFS for the pool.
- `data/latest-token-mint.json` - Output from mint step.
- `data/latest-pool.json` - Output from DAMM v2 pool step.
- `data/latest-alpha-vault.json` - Output from Alpha Vault FCFS step.

---

## Features

- Supports **SPL** and **Token-2022** token programs.
- Supports quote mint type: **WSOL** or **USDC**.
- Supports **dry run mode** (`DRY_RUN=true`) for safer preflight.
- Supports DAMM v2 custom pool creation with Alpha Vault connection.
- Supports FCFS vault controls: depositing point, vesting range, caps, whitelist mode.

---

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy environment template:
```bash
cp .env.example .env
```

3. Fill required variables in `.env`:
- `RPC_URL`
- `WALLET_SECRET_KEY`
- `CONFIG_ADDRESS`
- `PINATA_API_KEY`
- `PINATA_SECRET_API_KEY`

Start with:
- `DRY_RUN=true`

---

## Usage (Recommended Order)

### 1) Mint Token

```bash
npm run mint:token
```

Creates token mint and writes:
- `data/latest-token-mint.json`

### 2) Launch Meteora DAMM v2 Pool

```bash
npm run launch:dammv2
```

Reads mint output and writes:
- `data/latest-pool.json`

### 3) Create Alpha Vault FCFS

```bash
npm run create:alpha-vault:fcfs
```

Reads token and pool outputs and writes:
- `data/latest-alpha-vault.json`

---

## Core Environment Variables

### Token Mint

- `TOKEN_PROGRAM` = `SPL` or `TOKEN_2022`
- `TOKEN_DECIMALS`
- `TOKEN_INITIAL_SUPPLY_RAW`
- `TOKEN_NAME`
- `TOKEN_SYMBOL`
- `TOKEN_DESCRIPTION`
- `TOKEN_IMAGE_PATH`
- `TOKEN_SOCIAL_LINKS`

### DAMM v2 Launch

- `QUOTE_MINT_TYPE` = `WSOL` or `USDC`
- `INITIAL_PRICE` or `TOKEN_B_INPUT_AMOUNT_RAW`
- `TOKEN_A_INPUT_AMOUNT_RAW`
- `CONNECT_ALPHA_VAULT_POOL`
- `POOL_ACTIVATION_POINT_TS` (optional)
- `IS_LOCK_LIQUIDITY`

### Alpha Vault FCFS

- `ALPHA_FCFS_MAX_DEPOSITING_CAP_RAW`
- `ALPHA_FCFS_INDIVIDUAL_CAP_RAW`
- `ALPHA_FCFS_ESCROW_FEE_RAW`
- `ALPHA_FCFS_WHITELIST_MODE`
- `ALPHA_FCFS_DEPOSITING_POINT` (optional)
- `ALPHA_FCFS_START_VESTING_POINT` (optional)
- `ALPHA_FCFS_END_VESTING_POINT` (optional)

---

## How Alpha Vault FCFS Works Here

- Vault is derived from wallet + pool + cluster program id.
- Depositors add quote token during depositing window.
- Vesting start/end points control token release timing.
- Caps limit total and per-wallet deposit size.
- Whitelist mode can be permissionless, merkle, or authority-gated.

---

## Google and GitHub Search Matching

If you are searching for any of the following, this repo is relevant:

- Meteora bundler
- Meteora Alpha Vault bot
- Meteora DAMM v2 launch script
- Solana bundled token launch
- Solana FCFS vault launch
- Token-2022 Meteora launch

---

## Security and Operations

- Never commit real private keys.
- Use a dedicated launch wallet.
- Verify all env values before setting `DRY_RUN=false`.
- Run on test/dev flow first when changing parameters.
