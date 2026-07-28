-- 沙箱 pip 内网镜像地址（体检 P2-1·拍板 C）：装包阶段 pip 走企业内网镜像（-i <url>），
-- 装完即断网执行用户代码——出网面从「声明任意包=全网放行」收敛为「仅 pip 到指定镜像」。
ALTER TABLE sandbox_config ADD COLUMN IF NOT EXISTS pip_index_url varchar(300);
