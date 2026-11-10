import { z } from 'zod';
import { catalogService } from '../catalog/catalog.service';
import { auditLogger } from '@/lib/security/audit-logger';

// ---------------------------------------------------------------------------
// 1. Zod Schemas for Tool Argument Validation
// ---------------------------------------------------------------------------

export const SearchProductsArgsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .max(100, 'Search query too long')
      .optional(),
    category: z
      .string()
      .trim()
      .max(50, 'Category too long')
      .optional(),
    maxPrice: z
      .number()
      .positive('maxPrice must be positive')
      .max(10_000_000, 'maxPrice exceeds limit')
      .optional(),
    minPrice: z
      .number()
      .nonnegative('minPrice must be non-negative')
      .max(10_000_000, 'minPrice exceeds limit')
      .optional()
  })
  .strict();

export const GetProductDetailsArgsSchema = z
  .object({
    productId: z
      .string()
      .trim()
      .min(1, 'Product ID must not be empty')
      .max(64, 'Product ID too long')
      .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid product ID format')
  })
  .strict();

export const CompareProductsArgsSchema = z
  .object({
    productIds: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_-]+$/)
      )
      .min(2, 'Must compare at least 2 products')
      .max(10, 'Cannot compare more than 10 products simultaneously')
  })
  .strict();

export const ValidateBudgetArgsSchema = z
  .object({
    items: z
      .array(
        z.object({
          productId: z
            .string()
            .trim()
            .min(1)
            .max(64)
            .regex(/^[a-zA-Z0-9_-]+$/),
          quantity: z
            .number()
            .int('Quantity must be an integer')
            .min(1, 'Quantity must be at least 1')
            .max(999, 'Quantity exceeds maximum limit')
        })
      )
      .min(1, 'Must provide at least one item to validate')
      .max(50, 'Cannot validate more than 50 items at once'),
    maxBudget: z
      .number()
      .positive('maxBudget must be positive')
      .max(10_000_000, 'maxBudget exceeds limit')
  })
  .strict();

export type SearchProductsArgs = z.infer<typeof SearchProductsArgsSchema>;
export type GetProductDetailsArgs = z.infer<typeof GetProductDetailsArgsSchema>;
export type CompareProductsArgs = z.infer<typeof CompareProductsArgsSchema>;
export type ValidateBudgetArgs = z.infer<typeof ValidateBudgetArgsSchema>;

// ---------------------------------------------------------------------------
// 2. Gemini v1beta Function Declarations
// ---------------------------------------------------------------------------

export const CATALOG_FUNCTION_DECLARATIONS = [
  {
    name: 'search_products',
    description: 'Search authoritative catalog products by keywords, category, or price range.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Search keywords such as "ergonomic chair", "laptop", "monitor", "cable"'
        },
        category: {
          type: 'STRING',
          description: 'Category name: "Hardware", "Peripherals", "Furniture", "Software", "Networking", or "Cloud & Hosting"'
        },
        maxPrice: {
          type: 'NUMBER',
          description: 'Maximum allowable unit price in USD'
        },
        minPrice: {
          type: 'NUMBER',
          description: 'Minimum allowable unit price in USD'
        }
      }
    }
  },
  {
    name: 'get_product_details',
    description: 'Retrieve full specifications, stock count, and pricing for a specific product ID.',
    parameters: {
      type: 'OBJECT',
      properties: {
        productId: {
          type: 'STRING',
          description: 'Unique identifier of the catalog product (e.g. "prod_chair_ergo")'
        }
      },
      required: ['productId']
    }
  },
  {
    name: 'compare_products',
    description: 'Compare 2 to 10 products side-by-side to evaluate specifications, pricing, and pros/cons.',
    parameters: {
      type: 'OBJECT',
      properties: {
        productIds: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'List of product IDs to compare'
        }
      },
      required: ['productIds']
    }
  },
  {
    name: 'validate_budget',
    description: 'Check whether a proposed list of items and quantities fits strictly within a total budget limit.',
    parameters: {
      type: 'OBJECT',
      properties: {
        items: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              productId: { type: 'STRING', description: 'Product ID' },
              quantity: { type: 'NUMBER', description: 'Quantity (must be integer >= 1)' }
            },
            required: ['productId', 'quantity']
          },
          description: 'Array of proposed product items and quantities'
        },
        maxBudget: {
          type: 'NUMBER',
          description: 'Maximum allowable total budget in USD'
        }
      },
      required: ['items', 'maxBudget']
    }
  }
];

export const ALLOWED_TOOL_NAMES = [
  'search_products',
  'get_product_details',
  'compare_products',
  'validate_budget'
] as const;

export type AllowedToolName = (typeof ALLOWED_TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// 3. Server-Side Tool Execution Engine
// ---------------------------------------------------------------------------

export interface ToolExecutionResult {
  toolName: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export async function executeCatalogTool(
  toolName: string,
  rawArgs: unknown
): Promise<ToolExecutionResult> {
  // CRITICAL SECURITY GUARDRAIL: Strict tool name check
  if (!ALLOWED_TOOL_NAMES.includes(toolName as AllowedToolName)) {
    auditLogger.log(
      'UNAUTHORIZED_TOOL_INVOCATION',
      'WARN',
      `Attempted invocation of unauthorized or forbidden tool: "${toolName}". Only read-only catalog tools are permitted.`,
      { details: { attemptedTool: toolName } }
    );
    return {
      toolName,
      success: false,
      error: `Security violation: Tool "${toolName}" is not permitted. The AI agent only has access to read-only catalog tools and cannot execute purchases or payments.`
    };
  }

  try {
    switch (toolName) {
      case 'search_products': {
        const validation = SearchProductsArgsSchema.safeParse(rawArgs || {});
        if (!validation.success) {
          return {
            toolName,
            success: false,
            error: `Invalid search_products arguments: ${validation.error.issues.map((i) => i.message).join('; ')}`
          };
        }
        const { query, category, maxPrice, minPrice } = validation.data;
        const validCategories = ['Computing', 'Ergonomics', 'Displays', 'Audio', 'Peripherals', 'Networking'] as const;
        const matchedCategory = validCategories.find(
          (c) => c.toLowerCase() === category?.toLowerCase()
        );

        const matching = catalogService.getProducts({
          searchQuery: query,
          category: matchedCategory,
          maxPrice,
          minPrice
        });

        // Return clean, summarized product entries to prevent token bloat
        const productsSummary = matching.map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category,
          price: p.price,
          inStock: p.inStock,
          stockCount: p.stockCount,
          brand: p.brand,
          shortDescription: p.shortDescription,
          specifications: p.specifications
        }));

        return {
          toolName,
          success: true,
          result: {
            totalMatches: productsSummary.length,
            products: productsSummary
          }
        };
      }

      case 'get_product_details': {
        const validation = GetProductDetailsArgsSchema.safeParse(rawArgs);
        if (!validation.success) {
          return {
            toolName,
            success: false,
            error: `Invalid get_product_details arguments: ${validation.error.issues.map((i) => i.message).join('; ')}`
          };
        }
        const product = catalogService.getProductById(validation.data.productId);
        if (!product) {
          return {
            toolName,
            success: false,
            error: `Product with ID "${validation.data.productId}" does not exist in the authoritative catalog.`
          };
        }
        return {
          toolName,
          success: true,
          result: { product }
        };
      }

      case 'compare_products': {
        const validation = CompareProductsArgsSchema.safeParse(rawArgs);
        if (!validation.success) {
          return {
            toolName,
            success: false,
            error: `Invalid compare_products arguments: ${validation.error.issues.map((i) => i.message).join('; ')}`
          };
        }
        const products = catalogService.getProductsForComparison(validation.data.productIds);
        return {
          toolName,
          success: true,
          result: {
            comparedCount: products.length,
            products: products.map((p) => ({
              id: p.id,
              name: p.name,
              brand: p.brand,
              category: p.category,
              price: p.price,
              tier: p.tier,
              specifications: p.specifications,
              features: p.features
            }))
          }
        };
      }

      case 'validate_budget': {
        const validation = ValidateBudgetArgsSchema.safeParse(rawArgs);
        if (!validation.success) {
          return {
            toolName,
            success: false,
            error: `Invalid validate_budget arguments: ${validation.error.issues.map((i) => i.message).join('; ')}`
          };
        }
        const reconciled = catalogService.reconcileCart(
          validation.data.items,
          validation.data.maxBudget
        );
        return {
          toolName,
          success: true,
          result: {
            isValid: reconciled.isValid,
            totalAmount: reconciled.verifiedTotal,
            subtotal: reconciled.verifiedSubtotal,
            tax: reconciled.verifiedTax,
            shipping: reconciled.verifiedShipping,
            maxBudget: validation.data.maxBudget,
            withinBudget: reconciled.budgetCheck.isWithinBudget,
            difference: Math.round((validation.data.maxBudget - reconciled.verifiedTotal) * 100) / 100,
            itemCount: reconciled.verifiedItems.length,
            currency: 'USD'
          }
        };
      }

      default:
        return {
          toolName,
          success: false,
          error: `Unhandled tool: ${toolName}`
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Execution failed';
    return {
      toolName,
      success: false,
      error: `Tool execution exception: ${message}`
    };
  }
}
