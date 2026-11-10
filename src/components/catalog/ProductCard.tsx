'use client';

import React from 'react';
import Image from 'next/image';
import { Product } from '@/types/product';
import { useCart } from '@/context/CartContext';
import { Star, ShoppingCart, ArrowLeftRight, Check, Info } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

interface ProductCardProps {
  product: Product;
  highlighted?: boolean;
}

export function ProductCard({ product, highlighted = false }: ProductCardProps) {
  const { cart, addToCart, compareList, addToCompare, removeFromCompare, setSelectedProductDetail } = useCart();

  const isItemInCart = cart.some((item) => item.product.id === product.id);
  const isCompared = compareList.some((p) => p.id === product.id);

  const getBadgeVariant = (badge?: string) => {
    switch (badge) {
      case 'Enterprise Pick':
        return 'purple';
      case 'Ergonomic Choice':
        return 'success';
      case 'Top Value':
        return 'warning';
      default:
        return 'navy';
    }
  };

  const topSpecs = Object.entries(product.specifications).slice(0, 3);

  return (
    <div
      className={`group relative flex flex-col rounded-xl bg-slate-900/90 border transition-all duration-200 overflow-hidden ${
        highlighted
          ? 'border-purple-500/70 shadow-lg shadow-purple-950/40 ring-1 ring-purple-500/40'
          : 'border-slate-800/90 hover:border-slate-700 hover:shadow-md hover:shadow-black/40'
      }`}
    >
      {/* Top Banner / Badge */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5">
        {product.badge && (
          <Badge variant={getBadgeVariant(product.badge)} size="sm">
            {product.badge}
          </Badge>
        )}
      </div>

      <div className="absolute top-3 right-3 z-10">
        <button
          onClick={() => setSelectedProductDetail(product)}
          className="p-1.5 rounded-lg bg-slate-900/80 hover:bg-slate-800 text-slate-400 hover:text-white border border-slate-700/60 backdrop-blur-sm transition-colors"
          title="View full technical specs"
        >
          <Info className="w-4 h-4" />
        </button>
      </div>

      {/* Image Area */}
      <div
        className="relative h-48 w-full bg-slate-950 cursor-pointer overflow-hidden"
        onClick={() => setSelectedProductDetail(product)}
      >
        <Image
          src={product.imageUrl}
          alt={product.name}
          fill
          sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
          className="object-cover transition-transform duration-500 group-hover:scale-105 opacity-90 group-hover:opacity-100"
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-transparent to-transparent opacity-80" />
      </div>

      {/* Content */}
      <div className="flex flex-col flex-1 p-4.5 space-y-3">
        {/* Brand & Category */}
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span className="font-semibold text-purple-400 uppercase tracking-wider text-[11px]">
            {product.brand}
          </span>
          <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/50 text-slate-300">
            {product.category}
          </span>
        </div>

        {/* Title */}
        <h3
          onClick={() => setSelectedProductDetail(product)}
          className="text-sm font-semibold text-slate-100 hover:text-purple-300 transition-colors line-clamp-2 cursor-pointer leading-snug"
        >
          {product.name}
        </h3>

        {/* Short Description */}
        <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
          {product.shortDescription}
        </p>

        {/* Specifications snippet */}
        <div className="pt-2 border-t border-slate-800/80 space-y-1 text-[11px]">
          {topSpecs.map(([key, val]) => (
            <div key={key} className="flex justify-between items-center text-slate-400">
              <span className="text-slate-500 truncate max-w-[45%]">{key}:</span>
              <span className="text-slate-300 font-medium truncate max-w-[55%] text-right">{val}</span>
            </div>
          ))}
        </div>

        {/* Rating and Reviews */}
        <div className="flex items-center gap-1.5 text-xs text-slate-400 pt-1">
          <div className="flex items-center text-amber-400">
            <Star className="w-3.5 h-3.5 fill-amber-400" />
            <span className="ml-1 font-semibold text-slate-200">{product.rating}</span>
          </div>
          <span className="text-slate-600">•</span>
          <span className="text-slate-400">({product.reviewCount} reviews)</span>
          <span className="text-slate-600">•</span>
          <span className="text-emerald-400 font-medium">In Stock ({product.stockCount})</span>
        </div>

        <div className="flex-1" />

        {/* Price & Action Footer */}
        <div className="pt-3 border-t border-slate-800/90 flex items-center justify-between gap-2">
          <div>
            <span className="text-[10px] text-slate-500 block uppercase font-medium">Verified Price</span>
            <span className="text-lg font-bold text-white tracking-tight">
              ${product.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => (isCompared ? removeFromCompare(product.id) : addToCompare(product))}
              className={`p-2 rounded-lg border text-xs transition-colors ${
                isCompared
                  ? 'bg-purple-950/80 border-purple-600 text-purple-300'
                  : 'bg-slate-800/70 border-slate-700/80 text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
              title={isCompared ? 'Remove from comparison' : 'Compare with other products'}
            >
              <ArrowLeftRight className="w-4 h-4" />
            </button>

            <Button
              size="sm"
              variant={isItemInCart ? 'secondary' : 'primary'}
              onClick={() => addToCart(product, 1)}
              className="gap-1.5"
            >
              {isItemInCart ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Added</span>
                </>
              ) : (
                <>
                  <ShoppingCart className="w-3.5 h-3.5" />
                  <span>Add to Cart</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
