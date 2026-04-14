# FFGR POS + Shipday Bridge

This starter app gives you a practical automation path for FFGR:

1. WooCommerce order created/updated -> create or update Shipday delivery
2. Shipday status callback -> update your system / optional WooCommerce order note
3. Optional Loyverse webhook endpoint -> future POS-triggered dispatch flow

## Recommended architecture for FFGR

### Phase 1 (best first step)
WooCommerce is the trigger for delivery orders.
- Customer places delivery order on website
- WooCommerce webhook hits this service
- Service creates Shipday order
- Shipday driver app handles pickup / on-the-way / delivered

### Phase 2
Enable Loyverse webhook handling for phone / Viber / walk-in delivery orders.
- Cashier creates receipt or tagged order in Loyverse
- Loyverse webhook hits this service
- Service creates Shipday order

## Why WooCommerce first?
It is the cleanest event source for delivery because the order already contains customer address, phone, items and total.

## Install
```bash
npm install
cp .env.example .env
npm start
```

## Endpoints
- `GET /health`
- `POST /webhooks/woocommerce/order-created`
- `POST /webhooks/woocommerce/order-updated`
- `POST /webhooks/shipday/status`
- `POST /webhooks/loyverse`

## WooCommerce setup
Create webhooks in WooCommerce:
- Topic: Order Created
- Topic: Order Updated
- Delivery URL:
  - `https://YOUR-DOMAIN/webhooks/woocommerce/order-created`
  - `https://YOUR-DOMAIN/webhooks/woocommerce/order-updated`
- Secret: same value as `WC_WEBHOOK_SECRET`

## Shipday setup
- Copy API key from your Shipday account
- Put it in `.env` as `SHIPDAY_API_KEY`
- Add your own drivers in Shipday Dispatch
- Drivers install Shipday Drive

## Auto assignment
This starter keeps auto assignment OFF by default because driver/carrier assignment rules vary by account.

If your Shipday account supports a stable assign flow for your own fleet, you can:
- set `SHIPDAY_AUTO_ASSIGN=true`
- set `SHIPDAY_CARRIER_NAME=Exact Driver/Carrier Name`
- adjust the `assignShipdayOrder()` function as needed

## Notes
- This starter stores no database mapping. For production, add a database table that stores:
  - WooCommerce order id
  - Shipday order id
  - Shipday tracking id
  - Loyverse receipt id (optional)
- If you want true two-way status sync into WooCommerce and Loyverse, add those API write-backs in `handleShipdayStatus()`.
