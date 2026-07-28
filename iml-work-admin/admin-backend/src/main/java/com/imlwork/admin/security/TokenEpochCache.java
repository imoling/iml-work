package com.imlwork.admin.security;

import com.imlwork.admin.repository.UserRepository;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 用户令牌纪元缓存（体检 P2-5）：JwtAuthFilter 每个请求都要比对 token 的 ep 与用户当前纪元，
 * 直查库等于给每个请求加一次 SELECT。纪元只在改密/强制下线时变（低频写），所以：
 * 读走内存缓存（60s TTL 兜底），写时由 {@link #invalidate} 主动失效——撤销即时生效，不等 TTL。
 */
@Component
public class TokenEpochCache {

    private static final long TTL_MS = 60_000;

    private record Entry(long epoch, long at) {}

    private final UserRepository userRepository;
    private final Map<String, Entry> cache = new ConcurrentHashMap<>();

    public TokenEpochCache(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    /** 用户当前纪元；用户不存在按 -1（与任何已签发 token 的 ep 都不等 → 拒绝）。 */
    public long current(String userId) {
        if (userId == null || userId.isBlank()) return -1;
        Entry e = cache.get(userId);
        long now = System.currentTimeMillis();
        if (e != null && now - e.at() < TTL_MS) return e.epoch();
        long ep = userRepository.findById(userId).map(u -> u.getTokenEpoch()).orElse(-1L);
        cache.put(userId, new Entry(ep, now));
        return ep;
    }

    /** 纪元变更后立即失效（改密 / 管理员强制下线）。 */
    public void invalidate(String userId) {
        if (userId != null) cache.remove(userId);
    }
}
