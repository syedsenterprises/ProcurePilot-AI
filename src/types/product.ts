export type ProductCategory = 
  | 'Computing'
  | 'Ergonomics'
  | 'Displays'
  | 'Audio'
  | 'Peripherals'
  | 'Networking';

export type ProductTier = 'Essential' | 'Mid-Tier' | 'Flagship' | 'Enterprise';

export interface Product {
  id: string;
  sku: string;
  name: string;
  brand: string;
  category: ProductCategory;
  tier: ProductTier;
  price: number; // In USD, fixed authoritative server price
  currency: 'USD';
  shortDescription: string;
  description: string;
  specifications: Record<string, string>;
  features: string[];
  inStock: boolean;
  stockCount: number;
  leadTimeDays: number;
  rating: number;
  reviewCount: number;
  imageUrl: string;
  badge?: 'Best Seller' | 'Top Value' | 'Enterprise Pick' | 'Ergonomic Choice';
  tags: string[];
}

export interface ProductFilterOptions {
  category?: ProductCategory | 'All';
  tier?: ProductTier | 'All';
  minPrice?: number;
  maxPrice?: number;
  searchQuery?: string;
  inStockOnly?: boolean;
  sortBy?: 'price-asc' | 'price-desc' | 'rating' | 'featured';
}
