'use client';

import React from 'react';
import Image from 'next/image';
import { CartItem } from '@/types/cart';
import { useCart } from '@/context/CartContext';
import { Minus, Plus, Trash2 } from 'lucide-react';

interface CartItemRowProps {
  item: CartItem;
}

export function CartItemRow({ item }: CartItemRowProps) {
  const { updateQuantity, removeFromCart, setSelectedProductDetail } = useCart();
  const { product, quantity } = item;

  const lineTotal = product.price * quantity;

  return (
    <div className="flex items-center gap-3.5 p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700/80 transition-colors">
      {/* Image */}
      <div
        className="relative h-16 w-16 rounded-lg overflow-hidden bg-slate-950 border border-slate-800 flex-shrink-0 cursor-pointer"
        onClick={() => setSelectedProductDetail(product)}
      >
        <Image
          src={product.imageUrl}
          alt={product.name}
          fill
          className="object-cover"
          unoptimized
        />
      </div>

      {/* Details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span className="font-semibold text-purple-400 uppercase text-[10px]">{product.brand}</span>
          <span>•</span>
          <span>{product.category}</span>
        </div>

        <h4
          className="text-xs font-semibold text-slate-200 hover:text-purple-300 transition-colors truncate cursor-pointer"
          onClick={() => setSelectedProductDetail(product)}
        >
          {product.name}
        </h4>

        <div className="flex items-center justify-between mt-1.5">
          <span className="text-xs font-bold text-white">
            ${lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
          <span className="text-[11px] text-slate-400">
            ${product.price.toLocaleString()} ea
          </span>
        </div>
      </div>

      {/* Quantity Controls */}
      <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
        <button
          onClick={() => removeFromCart(product.id)}
          className="text-slate-500 hover:text-rose-400 transition-colors p-1"
          title="Remove item"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>

        <div className="flex items-center rounded-lg bg-slate-950 border border-slate-800 p-0.5 text-xs text-slate-200">
          <button
            onClick={() => updateQuantity(product.id, quantity - 1)}
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition-colors"
            title="Decrease quantity"
          >
            <Minus className="w-3 h-3" />
          </button>
          <span className="px-2 font-mono font-semibold text-xs min-w-[20px] text-center">
            {quantity}
          </span>
          <button
            onClick={() => updateQuantity(product.id, quantity + 1)}
            disabled={quantity >= product.stockCount}
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Increase quantity"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
