import { NextRequest, NextResponse } from 'next/server';
import { catalogService } from '@/services/catalog/catalog.service';
import { ProductCategory, ProductFilterOptions, ProductTier } from '@/types/product';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const category = (searchParams.get('category') as ProductCategory | 'All') || 'All';
    const tier = (searchParams.get('tier') as ProductTier | 'All') || 'All';
    const minPrice = searchParams.get('minPrice') ? parseFloat(searchParams.get('minPrice')!) : undefined;
    const maxPrice = searchParams.get('maxPrice') ? parseFloat(searchParams.get('maxPrice')!) : undefined;
    const searchQuery = searchParams.get('searchQuery') || undefined;
    const inStockOnly = searchParams.get('inStockOnly') === 'true';
    const sortBy = (searchParams.get('sortBy') as ProductFilterOptions['sortBy']) || 'featured';

    const filters: ProductFilterOptions = {
      category,
      tier,
      minPrice,
      maxPrice,
      searchQuery,
      inStockOnly,
      sortBy
    };

    const products = catalogService.getProducts(filters);
    const allProducts = catalogService.getProducts();

    // Aggregate category counts
    const categoryCounts: Record<string, number> = { All: allProducts.length };
    for (const p of allProducts) {
      categoryCounts[p.category] = (categoryCounts[p.category] || 0) + 1;
    }

    return NextResponse.json({
      success: true,
      totalCount: products.length,
      categoryCounts,
      products
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to retrieve catalog'
      },
      { status: 500 }
    );
  }
}
