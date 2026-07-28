package com.imlwork.admin.security;

import com.imlwork.admin.model.User;
import com.imlwork.admin.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * 令牌纪元（体检 P2-5：给无状态 JWT 一个撤销手段）：
 * 缓存读、写后立即失效、用户不存在按 -1（与任何已签发 token 的 ep 都不等 → 拒绝）。
 */
class TokenEpochCacheTest {

    private final Map<String, User> store = new HashMap<>();
    private TokenEpochCache cache;
    private int dbReads;

    private User user(String id, long epoch) {
        User u = new User();
        u.setId(id);
        u.setUsername(id);
        u.setTokenEpoch(epoch);
        return u;
    }

    @BeforeEach
    void setUp() {
        store.clear();
        dbReads = 0;
        UserRepository repo = Mockito.mock(UserRepository.class);
        when(repo.findById(anyString())).thenAnswer(inv -> {
            dbReads++;
            return Optional.ofNullable(store.get(inv.<String>getArgument(0)));
        });
        cache = new TokenEpochCache(repo);
    }

    @Test
    void 读命中缓存_不重复查库() {
        store.put("u1", user("u1", 3));
        assertEquals(3, cache.current("u1"));
        assertEquals(3, cache.current("u1"));
        assertEquals(1, dbReads, "TTL 内第二次读应走缓存");
    }

    @Test
    void 撤销后立即生效_不等TTL() {
        store.put("u1", user("u1", 0));
        assertEquals(0, cache.current("u1"));
        // 模拟改密/强制下线：纪元 +1 并主动失效
        store.get("u1").setTokenEpoch(1);
        cache.invalidate("u1");
        assertEquals(1, cache.current("u1"), "撤销必须即时生效，不能等 60s TTL");
    }

    @Test
    void 用户不存在或空id_返回负一_使任何token都不匹配() {
        assertEquals(-1, cache.current("ghost"));
        assertEquals(-1, cache.current(null));
        assertEquals(-1, cache.current(""));
        // 已签发 token 的 ep 最小为 0，-1 与之不等 → 过滤器判定为已撤销
        assertNotEquals(0L, cache.current("ghost"));
    }
}
