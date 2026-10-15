// The Magento REST helpers of WebArena's and VisualWebArena's evaluators, as
// their helper_functions.py reads them: the admin token, the newest order, and
// a product's newest review. `site(id)` has the origin the judge reaches the
// site on, and the origin the agent saw.
type Site = (id: string) => { origin: string; canonical: string };

// Shopping admin's REST login, as upstream's helper_functions have it (users from wavSites).
const ADMIN = { username: "admin", password: "admin1234" };

async function rest(shop: string, path: string): Promise<unknown> {
  const token = await (await fetch(`${shop}/rest/default/V1/integration/admin/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ADMIN) })).json();
  const res = await fetch(`${shop}/rest/${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`the ${path.split("?")[0]} API answered ${res.status}`);
  return res.json();
}

export const shoppingRest = (site: Site) => {
  /** The newest review of a product, or none. */
  const review = async (sku: unknown) => ((await rest(site("shopping").origin, `V1/products/${sku}/reviews`)) as { nickname: string; detail: string; ratings: { percent: number }[] }[]).at(-1);
  return {
    // The newest order's page, from Magento's REST API as upstream's helper reads it.
    async shopping_get_latest_order_url() {
      const q = "searchCriteria[sortOrders][0][field]=created_at&searchCriteria[sortOrders][0][direction]=DESC&searchCriteria[pageSize]=1";
      const { items } = (await rest(site("shopping").origin, `V1/orders?${q}`)) as { items: { increment_id: string }[] };
      return `${site("shopping").canonical}/sales/order/view/order_id/${Number(items[0]!.increment_id)}/`;
    },
    shopping_get_sku_latest_review_author: async (sku: unknown) => (await review(sku))?.nickname ?? "",
    shopping_get_sku_latest_review_rating: async (sku: unknown) => String((await review(sku))?.ratings[0]?.percent ?? ""),
    shopping_get_sku_latest_review_text: async (sku: unknown) => (await review(sku))?.detail ?? "",
  };
};
