# BMI Public Booking API — Vouchers & Promo Codes (spec extract)

**Source:** BMI Leisure Confluence share — "Full Public Booking API Documentation"
(public-booking (6).json), by Angelina Obolonina, last updated **2026-06-25**.
Link: https://bmileisure.atlassian.net/wiki/external/YTYwMTA3YjAyNWVkNDAzMmJhNDkxZWE5OWZiYTc5YmM
Extracted 2026-07-27 (page is a JS-rendered public link — this file preserves the
voucher-relevant sections verbatim-adjacent for offline reference).

**Release status:** sections 20–22 below carry NO "not yet released" banner in the source
doc, while section 23 (payment options) and 24 (pay-on-site confirm) DO — i.e. the voucher
endpoints are **released**. This supersedes the 2026-04-21 note in
`apps/web/app/api/bmi/route.ts` that flagged `order/applyCode` / `order/removeCode` as
"not yet released" (they were allowlisted speculatively back then).

---

## 20. Sell a voucher

`POST /public-booking/{clientKey}/voucher/sell`

Sell a voucher product (adds a voucher line to an order). Supports gift-voucher metadata
(sender/recipient details, memo, picture), activation products bundled with the voucher,
and optional delayed activation.

```json
{
  "ProductId": 500,
  "ProductXref": null,
  "Quantity": 1,
  "OrderId": null,
  "PersonId": null,
  "ParentOrderItemId": null,
  "DynamicLines": null,
  "ActivationDate": "2026-05-01",
  "ActivationProducts": [{ "ProductId": 123, "Quantity": 2, "CustomAmount": null }],
  "SenderName": "John Doe",
  "RecipientName": "Jane Doe",
  "RecipientAddress": {
    "Email": "jane@example.com",
    "Mobile": "+3540000000",
    "AddressLine": "Main street 1",
    "CountryId": 352,
    "City": "Reykjavik",
    "ZipCode": "101"
  },
  "Memo": "Happy birthday!",
  "PictureId": 77
}
```

Request fields — `PublicVoucherSellInfo`:

| Property                   | Type                       | Description                                         | Mandatory |
| -------------------------- | -------------------------- | --------------------------------------------------- | --------- |
| ProductId                  | Long?                      | Voucher product id (use either this or ProductXref) | Yes\*     |
| ProductXref                | String                     | External reference of the voucher product           | Yes\*     |
| Quantity                   | Decimal                    | Number of vouchers to sell                          | Yes       |
| OrderId                    | Long?                      | Existing order to add to (null creates a new order) | No        |
| PersonId                   | Long?                      | Person to associate with the sale                   | No        |
| ParentOrderItemId          | Long?                      | Parent order item (modifiers/supplements)           | No        |
| DynamicLines               | PublicDynamicAgeGroup[]    | Age group breakdown                                 | No        |
| ActivationDate             | DateTime?                  | When the voucher becomes usable (null = immediate)  | No        |
| ActivationProducts         | PublicVoucherSaleProduct[] | Products bundled with the voucher                   | No        |
| SenderName / RecipientName | String                     | Gift voucher names                                  | No        |
| RecipientAddress           | PublicVoucherAddress       | Recipient contact/delivery details                  | No        |
| Memo                       | String                     | Note printed on the voucher                         | No        |
| PictureId                  | Long?                      | Voucher picture asset                               | No        |

`PublicVoucherSaleProduct`: `ProductId` (Long), `Quantity` (Int), `CustomAmount` (Decimal? —
override price, null = product default).
`PublicVoucherAddress`: `Email`, `Mobile`, `AddressLine`, `CountryId` (Long), `City`, `ZipCode`.

Response `200 OK` — `PublicProductSellResult` (same shape as "Add product to cart"):

```json
{
  "Success": true,
  "ErrorMessage": null,
  "OrderId": 1001,
  "OrderItemId": 5002,
  "Prices": [{ "Amount": 50.0, "Kind": 0, "ShortName": "m", "DepositKind": 0 }],
  "Modifiers": [],
  "Supplements": []
}
```

⚠️ Note: the sell response does NOT carry the voucher number/code. How the code is
generated/retrieved for delivery (print/QR/email) is an open question for BMI — see the
research doc.

## 21. Apply a voucher or discount code to an order

`POST /public-booking/{clientKey}/order/applyCode`

Apply a **voucher code or discount promo code** to an existing order. The code is validated
and — if accepted — recorded against the order; the updated order overview is returned.

```json
{ "OrderId": 1001, "Code": "SUMMER2026" }
```

| Property | Type   | Description                               | Mandatory |
| -------- | ------ | ----------------------------------------- | --------- |
| OrderId  | Long   | Order the code is applied to              | Yes       |
| Code     | String | The voucher number or discount promo code | Yes       |

Response `200 OK`: `PublicOrderOverview` (section 12) — `AppliedPromoCodes` reflects the
newly applied code. Errors: 400, 401, 500.

## 22. Remove a voucher or discount code from an order

`POST /public-booking/{clientKey}/order/removeCode`

```json
{ "OrderId": 1001, "VoucherOrderItemId": 5050, "DiscountId": null }
```

| Property           | Type  | Description                                        | Mandatory |
| ------------------ | ----- | -------------------------------------------------- | --------- |
| OrderId            | Long  | Order the code is removed from                     | Yes       |
| VoucherOrderItemId | Long? | Order item id of the applied **voucher** to remove | Yes\*     |
| DiscountId         | Long? | Id of the applied **discount promo** to remove     | Yes\*     |

Provide either `VoucherOrderItemId` or `DiscountId` — both are found on the
`AppliedPromoCodes` array of the order overview. Response: updated `PublicOrderOverview`.

## Order overview voucher surfaces (section 12)

`PublicOrderOverview.AppliedPromoCodes: AppliedPromoCode[]`:

| Property           | Type   | Description                                                          |
| ------------------ | ------ | -------------------------------------------------------------------- |
| Name               | String | Promo code name/value                                                |
| VoucherOrderItemId | Long?  | Order item id of the voucher line (matches `OrderItemId` in `Lines`) |
| DiscountId         | Long?  | Associated discount id                                               |
| Discount           | String | Discount display text                                                |

`PublicBillLine` additions: `VoucherCode` (String — voucher code applied to that line, null
if none), `Discount` (Decimal — discount amount applied to the line).

## Product model voucher surfaces (section 4)

`PublicProduct`: `IsVoucher` (Boolean), `VoucherMetaId` (Long? — reference to voucher
metadata, null when `IsVoucher` is false).

## ProductKind enum

| Value | Name          | Description                              |
| ----- | ------------- | ---------------------------------------- |
| 1     | Normal        | Standard non-activity product            |
| 2     | Entry         | Entry/admission product                  |
| 3     | Membership    | Membership                               |
| **4** | **Voucher**   | **Voucher**                              |
| 5     | GiftCard      | Gift card (user-defined value)           |
| 6     | Dynamic       | Combo with dynamic products (age groups) |
| 7     | Combo         | Combo/package product                    |
| 8     | ServiceCharge | Service charge                           |

---

## Integration hard rules (ours, not BMI's)

- `OrderId` / `OrderItemId` / `VoucherOrderItemId` / `ProductId` / `PersonId` are **Longs**
  that exceed `Number.MAX_SAFE_INTEGER` in production. Every call above MUST use
  `stringifyWithRawIds` for request bodies and `parseWithRawIds(await res.text())` for
  responses — never `JSON.stringify` / `res.json()`. See `tasks/lessons.md` § BMI ID Precision.
- `order/applyCode` + `order/removeCode` are already in the proxy allowlist
  (`apps/web/app/api/bmi/route.ts:78–84`); `voucher/sell` is NOT yet allowlisted.
