import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // 项目联动：规则知识库视图直接代理 RAG 检索服务（规避跨域，生产即网关模式）
    // 生产环境通过 RAG_PROXY_TARGET 指向 RAG 部署地址
    const target = process.env.RAG_PROXY_TARGET ?? "http://localhost:3000";
    return [
      {
        source: "/rag-api/:path*",
        destination: `${target}/:path*`,
      },
    ];
  },
};

export default nextConfig;
