'use client';

import React from 'react';
import { ProductCategory, ProductTier } from '@/types/product';
import { Search, RotateCcw } from 'lucide-react';

interface ProductFiltersProps {
  categories: Array<ProductCategory | 'All'>;
  selectedCategory: ProductCategory | 'All';
  onSelectCategory: (category: ProductCategory | 'All') => void;
  categoryCounts: Record<string, number>;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  sortBy: string;
  onSortChange: (sort: string) => void;
  selectedTier: ProductTier | 'All';
  onSelectTier: (tier: ProductTier | 'All') => void;
  inStockOnly: boolean;
  onToggleInStock: (val: boolean) => void;
  onReset: () => void;
}

export function ProductFilters({
  categories,
  selectedCategory,
  onSelectCategory,
  categoryCounts,
  searchQuery,
  onSearchChange,
  sortBy,
  onSortChange,
  selectedTier,
  onSelectTier,
  inStockOnly,
  onToggleInStock,
  onReset
}: ProductFiltersProps) {
  return (
    <div className="space-y-4">
      {/* Top Search & Controls Row */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
        {/* Search Bar */}
        <div className="relative w-full sm:w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            placeholder="Search products by model, brand, spec, or SKU..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-xs rounded-xl bg-slate-900 border border-slate-800 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-purple-500/80 transition-colors"
          />
        </div>

        {/* Filters and Sorting */}
        <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end">
          {/* Tier Selector */}
          <select
            value={selectedTier}
            onChange={(e) => onSelectTier(e.target.value as ProductTier | 'All')}
            className="px-3 py-2 text-xs rounded-xl bg-slate-900 border border-slate-800 text-slate-300 focus:outline-none focus:border-purple-500/80"
          >
            <option value="All">All Tiers</option>
            <option value="Essential">Essential</option>
            <option value="Mid-Tier">Mid-Tier</option>
            <option value="Flagship">Flagship</option>
            <option value="Enterprise">Enterprise</option>
          </select>

          {/* Sort By */}
          <select
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value)}
            className="px-3 py-2 text-xs rounded-xl bg-slate-900 border border-slate-800 text-slate-300 focus:outline-none focus:border-purple-500/80"
          >
            <option value="featured">Featured Benchmarks</option>
            <option value="price-asc">Price: Low to High</option>
            <option value="price-desc">Price: High to Low</option>
            <option value="rating">Highest Rated</option>
          </select>

          {/* In Stock Toggle */}
          <label className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-xl bg-slate-900 border border-slate-800 text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={inStockOnly}
              onChange={(e) => onToggleInStock(e.target.checked)}
              className="rounded bg-slate-800 border-slate-700 text-purple-600 focus:ring-0"
            />
            <span>In Stock</span>
          </label>

          {(searchQuery || selectedCategory !== 'All' || selectedTier !== 'All' || inStockOnly) && (
            <button
              onClick={onReset}
              className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700 transition-colors"
              title="Reset all filters"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Category Pills Bar */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
        {categories.map((cat) => {
          const isSelected = selectedCategory === cat;
          const count = categoryCounts[cat];
          return (
            <button
              key={cat}
              onClick={() => onSelectCategory(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-150 flex items-center gap-1.5 ${
                isSelected
                  ? 'bg-purple-600 text-white shadow-sm shadow-purple-900 border border-purple-500/50'
                  : 'bg-slate-900/80 text-slate-400 hover:text-slate-200 border border-slate-800 hover:border-slate-700'
              }`}
            >
              <span>{cat}</span>
              {count !== undefined && (
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                    isSelected ? 'bg-purple-700 text-purple-100' : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
