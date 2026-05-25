# EA Set File Creator

A shared-hosting friendly PHP application that analyzes closed EA trade-history CSV files and generates a MetaTrader-style `.set` file.

## Local Run

```bash
php -S 127.0.0.1:8000
```

Open:

```text
http://127.0.0.1:8000/
```

## Shared Hosting Upload

Upload these files to your hosting `public_html` or target folder:

- `index.php`
- `style.css`
- `script.js`

No database is required.

## CSV Format

Best results come from CSV files with these columns:

- `Symbol`
- `Action` with `Buy` or `Sell`
- `Pips`
- `Profit` or `Profit (USD)`
- `Open Date`
- `Close Date`

Deposit and balance rows are ignored automatically.

## Important

Enter only account balance, account currency, leverage, and trading pair. The app estimates all other values from the uploaded trade history, then lets you manually edit the generated values and visually compare your changes with the best generated set.

There is also a second tab for uploading an existing `.set` file and comparing it against the generated best values.

The generated `.set` file uses common EA input names such as `RiskPercent`, `FixedLot`, `StopLossPips`, and `TakeProfitPips`. If your EA uses different input names, rename the keys in the downloaded `.set` file to match your EA.

Always test generated settings in the Strategy Tester or on a demo account before using them live.
