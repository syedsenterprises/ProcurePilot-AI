import React from 'react';

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'purple' | 'navy';
  size?: 'sm' | 'md';
  className?: string;
}

export function Badge({ children, variant = 'default', size = 'sm', className = '' }: BadgeProps) {
  const baseStyles = 'inline-flex items-center font-medium rounded-full';
  
  const sizeStyles = {
    sm: 'text-xs px-2.5 py-0.5',
    md: 'text-sm px-3 py-1'
  };

  const variantStyles = {
    default: 'bg-slate-800 text-slate-300 border border-slate-700',
    success: 'bg-emerald-950/80 text-emerald-300 border border-emerald-800/60',
    warning: 'bg-amber-950/80 text-amber-300 border border-amber-800/60',
    danger: 'bg-rose-950/80 text-rose-300 border border-rose-800/60',
    purple: 'bg-purple-950/80 text-purple-300 border border-purple-800/60',
    navy: 'bg-indigo-950/80 text-indigo-300 border border-indigo-800/60'
  };

  return (
    <span className={`${baseStyles} ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}>
      {children}
    </span>
  );
}
