/**
 * PLU → Square Catalog ID mapping for group function products.
 *
 * Hermes products include a `plu` field that is actually the Square
 * catalog object ID (e.g. "CRMNHGI3WP2ILKJ4TTXFZWBL"). No translation
 * needed — pass through directly as catalog_object_id on the Square order.
 *
 * If a PLU is empty or missing, fall back to an ad-hoc line item
 * (name + price, no catalog link). This is fine for revenue recognition.
 */

export function buildSquareLineItem(
  _centerCode: string,
  product: { name: string; price: number; qty: number; plu: string },
): {
  name?: string;
  quantity: string;
  catalog_object_id?: string;
  base_price_money?: { amount: number; currency: string };
} {
  if (product.plu && product.plu.length > 10) {
    return {
      catalog_object_id: product.plu,
      quantity: String(product.qty),
      // Group-function catalog variations are variably priced, so Square rejects the order
      // ("variably priced and requires a value for base_price_money") unless we send an
      // explicit price even when the line is catalog-linked.
      base_price_money: {
        amount: Math.round(product.price * 100),
        currency: "USD",
      },
    };
  }

  return {
    name: product.name,
    quantity: String(product.qty),
    base_price_money: {
      amount: Math.round(product.price * 100),
      currency: "USD",
    },
  };
}
