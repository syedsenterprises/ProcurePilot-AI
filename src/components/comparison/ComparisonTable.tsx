'use client';

import React from 'react';
import Image from 'next/image';
import { Product } from '@/types/product';
import { useCart } from '@/context/CartContext';
import { Check, ShoppingCart, Trash2, Star } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

interface ComparisonTableProps {
  products: Product[];
}

export function ComparisonTable({ products }: ComparisonTableProps) {
  const { removeFromCompare, addToCart, cart } = useCart();

  if (products.length === 0) {
    return (
      <div className="py-12 text-center text-slate-400 text-xs">
        No products selected for comparison. Click the compare icon on any product card to start.
      </div>
    );
  }

  // Extract all unique spec keys across compared products
  const allSpecKeys = Array.from(
    new Set(products.flatMap((p) => Object.keys(p.specifications)))
  );

  return (
    <div className="overflow-x-auto pb-4">
      <table className="w-full border-collapse text-left text-xs text-slate-300">
        <thead>
          <tr>
            <th className="p-3 w-48 text-slate-400 font-semibold uppercase tracking-wider text-[11px] border-b border-slate-800 bg-slate-950/40">
              Metric / Feature
            </th>
            {products.map((product) => (
              <th
                key={product.id}
                className="p-4 min-w-[260px] max-w-[300px] border-b border-slate-800 bg-slate-900/60 align-top"
              >
                <div className="flex justify-between items-start mb-2">
                  <span className="text-[10px] uppercase font-bold text-purple-400">
                    {product.brand}
                  </span>
                  <button
                    onClick={() => removeFromCompare(product.id)}
                    className="text-slate-500 hover:text-rose-400 transition-colors p-1"
                    title="Remove from comparison"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="relative h-28 w-full rounded-lg overflow-hidden bg-slate-950 border border-slate-800 mb-2.5">
                  <Image
                    src={product.imageUrl}
                    alt={product.name}
                    fill
                    className="object-cover"
                    unoptimized
                  />
                </div>

                <h4 className="font-semibold text-slate-100 text-xs line-clamp-2 leading-tight mb-2">
                  {product.name}
                </h4>

                <div className="flex items-center gap-2 mb-3">
                  <span className="text-base font-bold text-white">
                    ${product.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                  <Badge variant="navy">{product.category}</Badge>
                </div>

                <Button
                  size="sm"
                  variant={cart.some((i) => i.product.id === product.id) ? 'secondary' : 'primary'}
                  className="w-full gap-1.5"
                  onClick={() => addToCart(product, 1)}
                >
                  <ShoppingCart className="w-3.5 h-3.5" />
                  <span>
                    {cart.some((i) => i.product.id === product.id) ? 'In Cart (+1)' : 'Add to Cart'}
                  </span>
                </Button>
              </th>
            ))}
          </tr>
        </thead>

        <tbody className="divide-y divide-slate-800/70">
          {/* Rating */}
          <tr className="hover:bg-slate-900/40">
            <td className="p-3 font-semibold text-slate-400 bg-slate-950/20">Enterprise Rating</td>
            {products.map((p) => (
              <td key={p.id} className="p-3">
                <div className="flex items-center gap-1 text-amber-400 font-semibold">
                  <Star className="w-3.5 h-3.5 fill-amber-400" />
                  <span>{p.rating}</span>
                  <span className="text-slate-500 font-normal">({p.reviewCount} reviews)</span>
                </div>
              </td>
            ))}
          </tr>

          {/* Tier & Badge */}
          <tr className="hover:bg-slate-900/40">
            <td className="p-3 font-semibold text-slate-400 bg-slate-950/20">Procurement Tier</td>
            {products.map((p) => (
              <td key={p.id} className="p-3">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-slate-200">{p.tier}</span>
                  {p.badge && <Badge variant="purple">{p.badge}</Badge>}
                </div>
              </td>
            ))}
          </tr>

          {/* Stock & Lead Time */}
          <tr className="hover:bg-slate-900/40">
            <td className="p-3 font-semibold text-slate-400 bg-slate-950/20">Availability</td>
            {products.map((p) => (
              <td key={p.id} className="p-3">
                <div className="space-y-0.5">
                  <span className="text-emerald-400 font-medium">In Stock ({p.stockCount} units)</span>
                  <span className="text-[11px] text-slate-500 block">Lead: {p.leadTimeDays} days</span>
                </div>
              </td>
            ))}
          </tr>

          {/* Dynamic Technical Specs */}
          {allSpecKeys.map((specKey) => (
            <tr key={specKey} className="hover:bg-slate-900/40">
              <td className="p-3 font-semibold text-slate-400 bg-slate-950/20">{specKey}</td>
              {products.map((p) => (
                <td key={p.id} className="p-3 font-mono text-[11px] text-slate-200">
                  {p.specifications[specKey] || <span className="text-slate-600">—</span>}
                </td>
              ))}
            </tr>
          ))}

          {/* Key Feature Highlights */}
          <tr className="hover:bg-slate-900/40">
            <td className="p-3 font-semibold text-slate-400 bg-slate-950/20">Core Strengths</td>
            {products.map((p) => (
              <td key={p.id} className="p-3">
                <ul className="space-y-1">
                  {p.features.slice(0, 3).map((feat, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-[11px] text-slate-300">
                      <Check className="w-3.5 h-3.5 text-purple-400 flex-shrink-0 mt-0.5" />
                      <span>{feat}</span>
                    </li>
                  ))}
                </ul>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
