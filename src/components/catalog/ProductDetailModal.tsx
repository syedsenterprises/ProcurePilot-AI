'use client';

import React from 'react';
import Image from 'next/image';
import { useCart } from '@/context/CartContext';
import { X, Star, ShieldCheck, Truck, Check, ShoppingCart, ArrowLeftRight } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

export function ProductDetailModal() {
  const { selectedProductDetail, setSelectedProductDetail, cart, addToCart, compareList, addToCompare, removeFromCompare } =
    useCart();

  if (!selectedProductDetail) return null;

  const product = selectedProductDetail;
  const isItemInCart = cart.some((item) => item.product.id === product.id);
  const isCompared = compareList.some((p) => p.id === product.id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fadeIn">
      <div
        className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl shadow-black text-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with Close */}
        <div className="sticky top-0 z-20 flex items-center justify-between p-4 bg-slate-900/90 backdrop-blur border-b border-slate-800">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase font-semibold text-purple-400 tracking-wider">
              {product.brand}
            </span>
            <span className="text-slate-600">•</span>
            <Badge variant="navy">{product.category}</Badge>
            {product.badge && <Badge variant="purple">{product.badge}</Badge>}
          </div>
          <button
            onClick={() => setSelectedProductDetail(null)}
            className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Main Hero Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
            <div className="relative h-64 md:h-80 w-full rounded-xl overflow-hidden bg-slate-950 border border-slate-800">
              <Image
                src={product.imageUrl}
                alt={product.name}
                fill
                className="object-cover"
                unoptimized
              />
            </div>

            <div className="space-y-4">
              <h2 className="text-xl font-bold text-white tracking-tight leading-snug">
                {product.name}
              </h2>

              <p className="text-xs text-slate-400 leading-relaxed">{product.description}</p>

              {/* Price Tag */}
              <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between">
                <div>
                  <span className="text-[11px] text-slate-500 uppercase block font-medium">
                    Authoritative Unit Price
                  </span>
                  <span className="text-2xl font-black text-white tracking-tight">
                    ${product.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                  <span className="text-xs text-slate-400 ml-1">USD</span>
                </div>

                <div className="text-right">
                  <div className="flex items-center gap-1 text-emerald-400 text-xs font-semibold">
                    <Check className="w-3.5 h-3.5" /> In Stock ({product.stockCount} units)
                  </div>
                  <span className="text-[11px] text-slate-500">
                    Lead time: {product.leadTimeDays} business days
                  </span>
                </div>
              </div>

              {/* Quick Actions */}
              <div className="flex items-center gap-3 pt-2">
                <Button
                  className="flex-1 gap-2"
                  variant={isItemInCart ? 'secondary' : 'primary'}
                  onClick={() => addToCart(product, 1)}
                >
                  <ShoppingCart className="w-4 h-4" />
                  <span>{isItemInCart ? 'Add Another to Cart' : 'Add to Procurement Cart'}</span>
                </Button>

                <Button
                  variant="outline"
                  onClick={() => (isCompared ? removeFromCompare(product.id) : addToCompare(product))}
                  className="gap-2"
                >
                  <ArrowLeftRight className="w-4 h-4" />
                  <span>{isCompared ? 'Compared' : 'Compare'}</span>
                </Button>
              </div>

              {/* Trust assurances */}
              <div className="grid grid-cols-2 gap-2 pt-2 text-[11px] text-slate-400">
                <div className="flex items-center gap-1.5">
                  <Truck className="w-3.5 h-3.5 text-purple-400" />
                  <span>Commercial Ground Delivery</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
                  <span>B2B Manufacturer Warranty</span>
                </div>
              </div>
            </div>
          </div>

          {/* Key Features */}
          <div className="space-y-2.5">
            <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Enterprise Feature Highlights
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {product.features.map((feat, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 p-2.5 rounded-lg bg-slate-950/40 border border-slate-800/60 text-xs text-slate-300"
                >
                  <Check className="w-4 h-4 text-purple-400 flex-shrink-0 mt-0.5" />
                  <span>{feat}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Detailed Specifications Table */}
          <div className="space-y-2.5">
            <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Technical Specifications & Architecture
            </h4>
            <div className="rounded-xl overflow-hidden border border-slate-800 divide-y divide-slate-800/80 bg-slate-950/50">
              {Object.entries(product.specifications).map(([specKey, specVal]) => (
                <div key={specKey} className="grid grid-cols-3 p-3 text-xs">
                  <span className="font-medium text-slate-400">{specKey}</span>
                  <span className="col-span-2 text-slate-200 font-mono text-[11.5px]">{specVal}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Metadata Footer */}
          <div className="flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-slate-800">
            <span>SKU: {product.sku}</span>
            <div className="flex items-center gap-1 text-amber-400">
              <Star className="w-3.5 h-3.5 fill-amber-400" />
              <span className="text-slate-300 font-semibold">{product.rating}</span>
              <span className="text-slate-500">({product.reviewCount} verified enterprise reviews)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
