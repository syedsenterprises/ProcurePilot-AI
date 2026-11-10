import { Product, ProductFilterOptions } from '@/types/product';
import { SAMPLE_PRODUCTS } from './products.data';
import { CartValidationResult } from '@/types/cart';

export class CatalogService {
  private static instance: CatalogService;
  private readonly products: Product[] = SAMPLE_PRODUCTS;

  private constructor() {}

  public static getInstance(): CatalogService {
    if (!CatalogService.instance) {
      CatalogService.instance = new CatalogService();
    }
    return CatalogService.instance;
  }

  /**
   * Authoritative list of all products with optional filtering and sorting
   */
  public getProducts(filters?: ProductFilterOptions): Product[] {
    let result = [...this.products];

    if (!filters) {
      return result;
    }

    if (filters.category && filters.category !== 'All') {
      result = result.filter((p) => p.category === filters.category);
    }

    if (filters.tier && filters.tier !== 'All') {
      result = result.filter((p) => p.tier === filters.tier);
    }

    if (filters.minPrice !== undefined) {
      result = result.filter((p) => p.price >= (filters.minPrice ?? 0));
    }

    if (filters.maxPrice !== undefined) {
      result = result.filter((p) => p.price <= (filters.maxPrice ?? Infinity));
    }

    if (filters.inStockOnly) {
      result = result.filter((p) => p.inStock && p.stockCount > 0);
    }

    if (filters.searchQuery && filters.searchQuery.trim().length > 0) {
      const q = filters.searchQuery.toLowerCase().trim();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.brand.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q) ||
          p.shortDescription.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)) ||
          Object.values(p.specifications).some((val) => val.toLowerCase().includes(q))
      );
    }

    if (filters.sortBy) {
      switch (filters.sortBy) {
        case 'price-asc':
          result.sort((a, b) => a.price - b.price);
          break;
        case 'price-desc':
          result.sort((a, b) => b.price - a.price);
          break;
        case 'rating':
          result.sort((a, b) => b.rating - a.rating);
          break;
        case 'featured':
        default:
          result.sort((a, b) => (b.badge ? 1 : 0) - (a.badge ? 1 : 0));
          break;
      }
    }

    return result;
  }

  /**
   * Authoritative single product lookup
   */
  public getProductById(id: string): Product | undefined {
    return this.products.find((p) => p.id === id);
  }

  /**
   * Compare multiple products side by side
   */
  public getProductsForComparison(ids: string[]): Product[] {
    return this.products.filter((p) => ids.includes(p.id));
  }

  /**
   * CRITICAL SECURITY FUNCTION:
   * Re-evaluates cart quantities against authoritative catalogue pricing.
   * NEVER trust client-submitted prices or totals.
   */
  public reconcileCart(
    clientItems: Array<{ productId: string; quantity: number }>,
    budgetCap?: number,
    userApprovalConfirmed: boolean = false
  ): CartValidationResult {
    const discrepancies: string[] = [];
    const verifiedItems: CartValidationResult['verifiedItems'] = [];
    let verifiedSubtotal = 0;

    for (const item of clientItems) {
      if (item.quantity <= 0) {
        discrepancies.push(`Item ${item.productId} has invalid non-positive quantity ${item.quantity}.`);
        continue;
      }

      const authoritativeProduct = this.getProductById(item.productId);
      if (!authoritativeProduct) {
        discrepancies.push(`Product ID ${item.productId} does not exist in authoritative catalog.`);
        continue;
      }

      if (!authoritativeProduct.inStock || authoritativeProduct.stockCount < item.quantity) {
        discrepancies.push(
          `Product "${authoritativeProduct.name}" exceeds available stock (Requested: ${item.quantity}, Stock: ${authoritativeProduct.stockCount}).`
        );
      }

      const lineTotal = authoritativeProduct.price * item.quantity;
      verifiedSubtotal += lineTotal;

      verifiedItems.push({
        productId: authoritativeProduct.id,
        name: authoritativeProduct.name,
        unitPrice: authoritativeProduct.price,
        quantity: item.quantity,
        lineTotal
      });
    }

    // Standard business tax estimation (8.25% commercial rate) and enterprise ground shipping ($25 or free over $1000)
    const verifiedTax = Math.round(verifiedSubtotal * 0.0825 * 100) / 100;
    const verifiedShipping = verifiedSubtotal >= 1000 || verifiedSubtotal === 0 ? 0 : 25.0;
    const verifiedTotal = Math.round((verifiedSubtotal + verifiedTax + verifiedShipping) * 100) / 100;

    const isWithinBudget = budgetCap !== undefined ? verifiedTotal <= budgetCap : true;
    if (budgetCap !== undefined && verifiedTotal > budgetCap) {
      discrepancies.push(
        `Total cart amount ($${verifiedTotal.toFixed(2)}) exceeds approved budget cap ($${budgetCap.toFixed(2)}).`
      );
    }

    return {
      isValid: discrepancies.length === 0,
      verifiedItems,
      verifiedSubtotal,
      verifiedTax,
      verifiedShipping,
      verifiedTotal,
      budgetCheck: {
        budgetCap,
        isWithinBudget,
        remainingBudget: budgetCap !== undefined ? budgetCap - verifiedTotal : undefined
      },
      humanApprovalRequired: true,
      humanApprovalProvided: userApprovalConfirmed,
      discrepancies,
      reconciliationTimestamp: new Date().toISOString()
    };
  }
}

export const catalogService = CatalogService.getInstance();
