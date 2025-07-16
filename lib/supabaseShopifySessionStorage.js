import { supabase } from './supabaseClient.js'; 
import { Session } from '@shopify/shopify-api';

// Helper para converter o objeto Session da Shopify para o formato da nossa tabela
function sessionToDb(session) {
  return {
    id: session.id,
    shop: session.shop,
    state: session.state,
    is_online: session.isOnline,
    scope: session.scope,
    expires: session.expires ? new Date(session.expires) : null,
    access_token: session.accessToken,
    user_id: session.onlineAccessInfo?.user_id?.toString(), // Assumindo que onlineAccessInfo pode ter user_id
    online_access_info: session.onlineAccessInfo,
    clerk_user_id: session.clerk_user_id || null,
  };
}

// Helper para converter o formato da nossa tabela de volta para o objeto Session da Shopify
function dbToSession(dbRow) {
  const sessionParams = {
    id: dbRow.id,
    shop: dbRow.shop,
    state: dbRow.state,
    isOnline: dbRow.is_online,
    accessToken: dbRow.access_token,
    scope: dbRow.scope,
  };
  if (dbRow.expires) {
    sessionParams.expires = new Date(dbRow.expires).getTime();
  }
  if (dbRow.online_access_info) {
    sessionParams.onlineAccessInfo = dbRow.online_access_info;
  }
  const session = new Session(sessionParams);
  return session;
}

export class SupabaseShopifySessionStorage {
  constructor() {
    if (!supabase) {
      throw new Error('Supabase client not initialized. Ensure supabaseClient.js is correctly set up and imported.');
    }
  }

  async storeSession(session) {
    console.log(`[SessionStorage] Storing session with ID: ${session.id} for Clerk User ID: ${session.clerk_user_id}`);
    const sessionData = sessionToDb(session);
    try {
      const { data, error } = await supabase
        .from('shopify_sessions')
        .upsert(sessionData, { onConflict: 'id' })
        .select();

      if (error) {
        console.error('[SessionStorage] Error storing session:', error.message, error.details);
        if (error.message.includes('column "clerk_user_id" of relation "shopify_sessions" does not exist')) {
            console.error("[SessionStorage] ERRO CRÍTICO: A coluna 'clerk_user_id' não existe na tabela 'shopify_sessions'. Execute o ALTER TABLE.");
        }
        return false;
      }
      console.log('[SessionStorage] Session stored/updated successfully:', data && data.length > 0 ? data[0]?.id : 'no data returned from select', `Clerk User ID: ${sessionData.clerk_user_id}`);
      return true;
    } catch (err) {
      console.error('[SessionStorage] Critical error in storeSession:', err);
      return false;
    }
  }

  async loadSession(id) {
    console.log(`[SessionStorage] Loading session with Shopify ID: ${id}`);
    try {
      const { data, error } = await supabase
        .from('shopify_sessions')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (error) {
        console.error('[SessionStorage] Error loading session by Shopify ID:', error.message, error.details);
        return undefined;
      }

      if (data) {
        console.log(`[SessionStorage] Session loaded by Shopify ID successfully: ${data.id}. Clerk User ID found: ${data.clerk_user_id}`);
        return dbToSession(data);
      }
      console.log(`[SessionStorage] No session found with Shopify ID: ${id}`);
      return undefined;
    } catch (err) {
      console.error('[SessionStorage] Critical error in loadSession (by Shopify ID):', err);
      return undefined;
    }
  }

  async deleteSession(id) {
    console.log(`[SessionStorage] Deleting session with Shopify ID: ${id}`);
    try {
      const { error } = await supabase
        .from('shopify_sessions')
        .delete()
        .eq('id', id);

      if (error) {
        console.error('[SessionStorage] Error deleting session by Shopify ID:', error.message, error.details);
        return false;
      }
      console.log('[SessionStorage] Session deleted successfully by Shopify ID (or did not exist).');
      return true;
    } catch (err) {
      console.error('[SessionStorage] Critical error in deleteSession (by Shopify ID):', err);
      return false;
    }
  }

  async deleteSessions(ids) {
    console.log(`[SessionStorage] Deleting multiple sessions with Shopify IDs: ${ids.join(', ')}`);
    try {
      const { error } = await supabase
        .from('shopify_sessions')
        .delete()
        .in('id', ids);

      if (error) {
        console.error('[SessionStorage] Error deleting multiple sessions by Shopify IDs:', error.message, error.details);
        return false;
      }
      console.log('[SessionStorage] Multiple sessions deleted successfully by Shopify IDs.');
      return true;
    } catch (err) {
      console.error('[SessionStorage] Critical error in deleteSessions (by Shopify IDs):', err);
      return false;
    }
  }

  async findSessionsByShop(shop) {
    console.log(`[SessionStorage] Finding sessions for shop: ${shop}`);
    try {
      const { data, error } = await supabase
        .from('shopify_sessions')
        .select('*')
        .eq('shop', shop);

      if (error) {
        console.error('[SessionStorage] Error finding sessions by shop:', error.message, error.details);
        return [];
      }

      if (data && data.length > 0) {
        console.log(`[SessionStorage] Found ${data.length} sessions for shop ${shop}.`);
        return data.map(dbRow => {
            const session = dbToSession(dbRow);
            return session;
        });
      }
      console.log(`[SessionStorage] No sessions found for shop: ${shop}`);
      return [];
    } catch (err) {
      console.error('[SessionStorage] Critical error in findSessionsByShop:', err);
      return [];
    }
  }

  async findSessionByClerkId(clerkUserId) {
    if (!clerkUserId) {
      console.error('[SessionStorage] findSessionByClerkId: clerkUserId is required.');
      return undefined;
    }
    console.log(`[SessionStorage] Finding session for Clerk User ID: ${clerkUserId}`);
    try {
      const { data, error } = await supabase
        .from('shopify_sessions')
        .select('*')
        .eq('clerk_user_id', clerkUserId)
        .maybeSingle();

      if (error) {
        console.error('[SessionStorage] Error finding session by Clerk User ID:', error.message, error.details);
        return undefined;
      }

      if (data) {
        console.log(`[SessionStorage] Session found for Clerk User ID ${clerkUserId}: Shop ${data.shop}, Session ID ${data.id}`);
        const session = dbToSession(data);
        return session;
      }
      console.log(`[SessionStorage] No session found for Clerk User ID: ${clerkUserId}`);
      return undefined;
    } catch (err) {
      console.error('[SessionStorage] Critical error in findSessionByClerkId:', err);
      return undefined;
    }
  }

  async deleteSessionsByClerkId(clerkUserId) {
    if (!clerkUserId) {
      console.error('[SessionStorage] deleteSessionsByClerkId: clerkUserId is required.');
      return false;
    }
    console.log(`[SessionStorage] Deleting all sessions for Clerk User ID: ${clerkUserId}`);
    try {
      const { error, count } = await supabase
        .from('shopify_sessions')
        .delete()
        .eq('clerk_user_id', clerkUserId);

      if (error) {
        console.error('[SessionStorage] Error deleting sessions by Clerk User ID:', error.message, error.details);
        return false;
      }
      console.log(`[SessionStorage] ${count || 0} sessions deleted for Clerk User ID: ${clerkUserId}.`);
      return true;
    } catch (err) {
      console.error('[SessionStorage] Critical error in deleteSessionsByClerkId:', err);
      return false;
    }
  }
} 