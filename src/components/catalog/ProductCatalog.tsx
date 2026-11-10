'use client';

import React, { useState, useMemo } from 'react';
import { Product, ProductCategory, ProductTier } from '@/types/product';
import { ProductCard } from './ProductCard';
import { ProductFilters } from './ProductFilters';
import { useCart } from '@/context/CartContext';
import { Package, ArrowLeftRight } from 'lucide-react';
import { Button } from '../ui/Button';

interface ProductCatalogProps {
  initialProducts: Product[];
  categoryCounts: Record<string, number>;
}

export function ProductCatalog({ initialProducts, categoryCounts }: ProductCatalogProps) {
  const { compareList, setIsCompareOpen, clearCompare } = useCart();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<ProductCategory | 'All'>('All');
  const [selectedTier, setSelectedTier] = useState<ProductTier | 'All'>('All');
  const [sortBy, setSortBy] = useState('featured');
  const [inStockOnly, setInStockOnly] = useState(false);

  const categories: Array<ProductCategory | 'All'> = [
    'All',
    'Computing',
    'Ergonomics',
    'Displays',
    'Audio',
    'Peripherals',
    'Networking'
  ];

  const filteredProducts = useMemo(() => {
    let result = [...initialProducts];

    if (selectedCategory !== 'All') {
      result = result.filter((p) => p.category === selectedCategory);
    }

    if (selectedTier !== 'All') {
      result = result.filter((p) => p.tier === selectedTier);
    }

    if (inStockOnly) {
      result = result.filter((p) => p.inStock && p.stockCount > 0);
    }

    if (searchQuery.trim().length > 0) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.brand.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q) ||
          p.shortDescription.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)) ||
          Object.values(p.specifications).some((val) => val.toLowerCase().includes(q))
      );
    }

    switch (sortBy) {
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

    return result;
  }, [initialProducts, selectedCategory, selectedTier, inStockOnly, searchQuery, sortBy]);

  const handleResetFilters = () => {
    setSearchQuery('');
    setSelectedCategory('All');
    setSelectedTier('All');
    setSortBy('featured');
    setInStockOnly(false);
  };

  return (
    <div className="space-y-6">
      {/* Filters Toolbar */}
      <ProductFilters
        categories={categories}
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
        categoryCounts={categoryCounts}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        sortBy={sortBy}
        onSortChange={setSortBy}
        selectedTier={selectedTier}
        onSelectTier={setSelectedTier}
        inStockOnly={inStockOnly}
        onToggleInStock={setInStockOnly}
        onReset={handleResetFilters}
      />

      {/* Catalog Grid */}
      {filteredProducts.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {filteredProducts.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      ) : (
        <div className="text-center py-16 px-4 rounded-2xl bg-slate-900/60 border border-slate-800/80">
          <Package className="w-10 h-10 text-slate-600 mx-auto mb-3" />
          <h3 className="text-sm font-semibold text-slate-200">No products match your criteria</h3>
          <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
            Try adjusting your search terms, changing the category, or resetting active filters.
          </p>
          <Button variant="outline" size="sm" onClick={handleResetFilters} className="mt-4">
            Reset All Filters
          </Button>
        </div>
      )}

      {/* Floating Compare Action Bar if items selected */}
      {compareList.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-4 px-4 py-2.5 rounded-full bg-slate-900/95 border border-purple-500/60 shadow-2xl shadow-black backdrop-blur-md text-xs text-slate-200 animate-slideUp">
          <div className="flex items-center gap-2">
            <span className="p-1 rounded-full bg-purple-950 text-purple-400 border border-purple-800">
              <ArrowLeftRight className="w-3.5 h-3.5" />
            </span>
            <span className="font-semibold text-white">
              {compareList.length} item{compareList.length > 1 ? 's' : ''} queued for comparison
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={() => setIsCompareOpen(true)}>
              Open Comparison Matrix
            </Button>
            <button
              onClick={clearCompare}
              className="text-slate-400 hover:text-white px-2 py-1 text-xs"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
